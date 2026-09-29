//! 看板自动化：领取 `ready` 卡片，投递分析 / 实施 turn，直到卡片进入终态。

use std::{collections::HashSet, sync::Arc, time::Duration};

use astrcode_extension_sdk::{
    extension::ExtensionTasks,
    host::{HostError, SessionControlClient},
    wire::session::{HostCreateRootSessionRequest, HostRootSubmitTurnRequest},
};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::{
    board::{BoardStore, BoardStoreError, Card, CardColumn, now_rfc3339},
    config::KanbanConfig,
    prompt,
};

#[derive(Debug, thiserror::Error)]
pub enum KanbanError {
    #[error("看板存储失败: {0}")]
    Store(#[from] BoardStoreError),
    #[error("宿主调用失败: {0}")]
    Host(#[from] HostError),
}

/// 自动化运行期状态。
///
/// `live_cards` 只记录「本进程内正在执行」的卡片，用于区分真正在跑的任务与进程重启后
/// 遗留的孤儿卡片。它不是看板状态的来源，看板状态始终来自磁盘。
pub struct KanbanRuntime {
    config: KanbanConfig,
    store: BoardStore,
    session_control: SessionControlClient,
    live_cards: Mutex<HashSet<String>>,
}

impl KanbanRuntime {
    pub fn new(
        config: KanbanConfig,
        store: BoardStore,
        session_control: SessionControlClient,
    ) -> Self {
        Self {
            config,
            store,
            session_control,
            live_cards: Mutex::new(HashSet::new()),
        }
    }

    pub fn config(&self) -> &KanbanConfig {
        &self.config
    }

    pub fn store(&self) -> &BoardStore {
        &self.store
    }

    /// 查询一张卡片当前是否处于实施阶段，供续跑判定使用。
    pub fn card_is_implementing(&self, session_id: &str) -> Result<bool, BoardStoreError> {
        self.store.read(|board| {
            board
                .card_by_session(session_id)
                .is_some_and(|card| card.column == CardColumn::Implementing)
        })
    }

    /// 一轮调度：先回收孤儿卡片，再在并发额度内领取 `ready` 卡片。
    pub fn tick(self: &Arc<Self>, tasks: &ExtensionTasks) {
        if let Err(error) = self.reconcile_orphans() {
            tracing::warn!(error = %error, "kanban orphan reconciliation failed");
        }
        if let Err(error) = self.claim_ready(tasks) {
            tracing::warn!(error = %error, "kanban claim failed");
        }
    }

    /// 进程重启后，运行中列里没有任何存活任务的卡片会被退回 `ready`。
    ///
    /// 已绑定的 session 会保留，重新领取时直接进入实施阶段，不重复分析。
    fn reconcile_orphans(&self) -> Result<(), KanbanError> {
        let orphans: Vec<String> = self.store.read(|board| {
            let live = self.live_cards.lock();
            board
                .cards
                .iter()
                .filter(|card| card.column.is_running() && !live.contains(&card.id))
                .map(|card| card.id.clone())
                .collect()
        })?;

        for card_id in orphans {
            tracing::info!(card_id = %card_id, "kanban card has no live runner, returning to ready");
            self.store.mutate(|board| {
                let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                    return Ok(());
                };
                if card.column.is_running() {
                    card.column = CardColumn::Ready;
                    card.note = Some("上一次执行未完成，已退回待领取".into());
                    card.updated_at = now_rfc3339();
                }
                Ok(())
            })?;
        }
        Ok(())
    }

    fn claim_ready(self: &Arc<Self>, tasks: &ExtensionTasks) -> Result<(), KanbanError> {
        let ready: Vec<String> = self.store.read(|board| {
            let slots = self
                .config
                .max_concurrent_cards
                .saturating_sub(board.running_count());
            board
                .cards
                .iter()
                .filter(|card| card.column == CardColumn::Ready)
                .take(slots)
                .map(|card| card.id.clone())
                .collect()
        })?;

        for card_id in ready {
            let claimed = self.store.mutate(|board| {
                let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                    return Ok(false);
                };
                if card.column != CardColumn::Ready {
                    return Ok(false);
                }
                if card.attempt >= self.config.max_attempts_per_card {
                    card.column = CardColumn::Blocked;
                    card.note = Some("尝试次数已用尽，等待人工介入".into());
                    card.updated_at = now_rfc3339();
                    return Ok(false);
                }
                // 已有 session 说明这是重启后的恢复，直接续做实施阶段。
                card.column = if card.session_id.is_some() {
                    CardColumn::Implementing
                } else {
                    CardColumn::Analyzing
                };
                card.updated_at = now_rfc3339();
                Ok(true)
            })?;

            if claimed {
                self.live_cards.lock().insert(card_id.clone());
                let runtime = Arc::clone(self);
                let task_name = format!("kanban-card-{card_id}");
                let claimed_card_id = card_id.clone();
                tasks.spawn(task_name, async move {
                    run_card(runtime, claimed_card_id).await;
                });
            }
        }
        Ok(())
    }

    fn reload(&self, card_id: &str) -> Result<Card, KanbanError> {
        self.store
            .read(|board| board.card(card_id).cloned())?
            .ok_or_else(|| BoardStoreError::CardNotFound(card_id.to_string()).into())
    }

    /// 把卡片迁到运行中列；卡片已进入终态时不做任何事。
    fn set_column(&self, card_id: &str, column: CardColumn) -> Result<(), KanbanError> {
        self.store.mutate(|board| {
            let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                return Err(BoardStoreError::CardNotFound(card_id.to_string()));
            };
            if !card.column.is_terminal() {
                card.column = column;
                card.updated_at = now_rfc3339();
            }
            Ok(())
        })?;
        Ok(())
    }

    fn bump_attempt(&self, card_id: &str) -> Result<(), KanbanError> {
        self.store.mutate(|board| {
            let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                return Err(BoardStoreError::CardNotFound(card_id.to_string()));
            };
            card.attempt = card.attempt.saturating_add(1);
            card.updated_at = now_rfc3339();
            Ok(())
        })?;
        Ok(())
    }

    fn block_card(&self, card_id: &str, note: &str) -> Result<(), KanbanError> {
        self.store.mutate(|board| {
            let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                return Err(BoardStoreError::CardNotFound(card_id.to_string()));
            };
            card.column = CardColumn::Blocked;
            card.note = Some(note.to_string());
            card.updated_at = now_rfc3339();
            Ok(())
        })?;
        Ok(())
    }

    async fn submit(&self, session_id: &str, prompt: String) -> Result<(), KanbanError> {
        self.session_control
            .submit_root_turn(HostRootSubmitTurnRequest::new(session_id, prompt))
            .await?;
        Ok(())
    }

    async fn execute_card(&self, card_id: &str) -> Result<(), KanbanError> {
        let card = self.reload(card_id)?;
        if card.column.is_terminal() {
            return Ok(());
        }
        let fresh = card.session_id.is_none();

        let session_id = match card.session_id {
            Some(session_id) => session_id,
            None => {
                let created = self
                    .session_control
                    .create_root(HostCreateRootSessionRequest {
                        working_dir: Some(card.working_dir.clone()),
                        ..HostCreateRootSessionRequest::default()
                    })
                    .await?;
                let session_id = created.session_id;
                let bound = session_id.clone();
                self.store.mutate(move |board| {
                    let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                        return Err(BoardStoreError::CardNotFound(card_id.to_string()));
                    };
                    card.session_id = Some(bound);
                    card.updated_at = now_rfc3339();
                    Ok(())
                })?;
                session_id
            },
        };

        if fresh {
            self.set_column(card_id, CardColumn::Analyzing)?;
            let analyze = prompt::analyze_prompt(&self.config, &self.reload(card_id)?);
            self.submit(&session_id, analyze).await?;
            if self.reload(card_id)?.column.is_terminal() {
                return Ok(());
            }
        }

        self.set_column(card_id, CardColumn::Implementing)?;
        loop {
            let current = self.reload(card_id)?;
            if current.column.is_terminal() {
                return Ok(());
            }
            if current.attempt >= self.config.max_attempts_per_card {
                self.block_card(card_id, "尝试次数已用尽，等待人工介入")?;
                return Ok(());
            }
            self.bump_attempt(card_id)?;
            let implement = prompt::implement_prompt(&self.config, &self.reload(card_id)?);
            self.submit(&session_id, implement).await?;
        }
    }
}

async fn run_card(runtime: Arc<KanbanRuntime>, card_id: String) {
    let _guard = LiveCardGuard {
        runtime: Arc::clone(&runtime),
        card_id: card_id.clone(),
    };
    if let Err(error) = runtime.execute_card(&card_id).await {
        tracing::warn!(card_id = %card_id, error = %error, "kanban card execution failed");
        if let Err(block_error) = runtime.block_card(&card_id, &format!("执行失败: {error}")) {
            tracing::warn!(card_id = %card_id, error = %block_error, "kanban card could not be blocked");
        }
    }
}

/// 保证卡片在任务结束（含提前返回）时离开存活集合。
struct LiveCardGuard {
    runtime: Arc<KanbanRuntime>,
    card_id: String,
}

impl Drop for LiveCardGuard {
    fn drop(&mut self) {
        self.runtime.live_cards.lock().remove(&self.card_id);
    }
}

/// 自动化轮询循环，随扩展生命周期取消。
pub async fn automation_loop(runtime: Arc<KanbanRuntime>, tasks: ExtensionTasks) {
    let interval = Duration::from_secs(runtime.config.poll_interval_secs);
    let cancellation: CancellationToken = tasks.cancellation();
    loop {
        tokio::select! {
            () = cancellation.cancelled() => break,
            () = tokio::time::sleep(interval) => {}
        }
        runtime.tick(&tasks);
    }
}
