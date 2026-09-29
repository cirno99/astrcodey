//! 看板自动化：领取 `ready` 卡片，投递分析 / 实施 turn，直到卡片进入终态。

use std::{sync::Arc, time::Duration};

use astrcode_extension_sdk::{
    extension::ExtensionTasks,
    host::{HostError, SessionControlClient},
    wire::session::{
        HostCreateRootSessionRequest, HostRootSubmitTurnRequest, HostSessionTargetRequest,
        SessionToolSelectionDto,
    },
};
use parking_lot::Mutex;
use rustc_hash::FxHashSet as HashSet;
use tokio_util::sync::CancellationToken;

use crate::{
    board::{Board, BoardStore, BoardStoreError, Card, CardColumn, now_rfc3339, project_key},
    config::KanbanConfig,
    failure::{self, CardAction},
    prompt,
};

/// 卡片会话不提供的工具：无人值守模式下没有用户可以应答。
///
/// 工具名由 `astrcode-extension-ask-user`
/// 定义（`crates/astrcode-extension-ask-user/src/model.rs`）； 内置插件只能依赖插件系统，
/// 无法引用该常量，故按字面量匹配。
const UNATTENDED_EXCLUDED_TOOLS: [&str; 1] = ["askUser"];

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
            live_cards: Mutex::new(HashSet::default()),
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
        let ready: Vec<String> = self
            .store
            .read(|board| select_claimable(board, &self.config))?;

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

    /// 退回待领取：保留 session，下一次领取直接续做实施阶段。
    fn retry_card(&self, card_id: &str, note: String) -> Result<(), KanbanError> {
        self.store.mutate(|board| {
            let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                return Err(BoardStoreError::CardNotFound(card_id.to_string()));
            };
            card.error_retries = card.error_retries.saturating_add(1);
            card.column = CardColumn::Ready;
            card.note = Some(note);
            card.updated_at = now_rfc3339();
            Ok(())
        })?;
        Ok(())
    }

    /// 换 session 重做：清空绑定与实施轮次，重新领取时会走分析阶段。
    fn restart_card(&self, card_id: &str, note: String) -> Result<(), KanbanError> {
        self.store.mutate(|board| {
            let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
                return Err(BoardStoreError::CardNotFound(card_id.to_string()));
            };
            card.error_retries = card.error_retries.saturating_add(1);
            card.session_id = None;
            card.attempt = 0;
            card.column = CardColumn::Ready;
            card.note = Some(note);
            card.updated_at = now_rfc3339();
            Ok(())
        })?;
        Ok(())
    }

    /// 执行失败后的处置：按失败类型决定重试同一 session、换 session 重做，还是置为终态。
    ///
    /// 预算耗尽一律置为终态，所以 `restart_card` 不会无限重启同一张卡片。
    async fn handle_failure(&self, card_id: &str, message: &str) -> Result<(), KanbanError> {
        let kind = failure::classify_failure(message);
        let (action, session_id) = self
            .store
            .read(|board| {
                board.card(card_id).map(|card| {
                    (
                        failure::next_action(
                            kind,
                            card.error_retries,
                            self.config.max_error_retries_per_card,
                        ),
                        card.session_id.clone(),
                    )
                })
            })?
            .ok_or_else(|| BoardStoreError::CardNotFound(card_id.to_string()))?;
        let label = failure::kind_label(kind);

        match action {
            CardAction::Block => {
                self.block_card(card_id, &format!("执行失败（{label}）: {message}"))
            },
            CardAction::RetrySameSession => self.retry_card(
                card_id,
                format!("上一次执行失败（{label}），已退回待领取: {message}"),
            ),
            CardAction::RestartSession => {
                if let Some(session_id) = session_id
                    && let Err(error) = self
                        .session_control
                        .dispose_root(HostSessionTargetRequest {
                            target_session_id: session_id,
                        })
                        .await
                {
                    tracing::warn!(
                        card_id = %card_id,
                        error = %error,
                        "kanban could not recycle the looping session"
                    );
                }
                self.restart_card(
                    card_id,
                    format!("上一次执行陷入重复输出（{label}），已新建会话重做: {message}"),
                )
            },
        }
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
                        tool_selection: Some(SessionToolSelectionDto::all_except(
                            UNATTENDED_EXCLUDED_TOOLS,
                        )),
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

/// 挑选本轮要领取的卡片：全局并发额度内，同一工作目录最多领取 `maxConcurrentCardsPerProject` 张。
///
/// 不同项目的卡片可以同时推进；同项目的卡片串行，避免两张卡在同一个工作区互相覆盖。
fn select_claimable(board: &Board, config: &KanbanConfig) -> Vec<String> {
    let mut slots = config
        .max_concurrent_cards
        .saturating_sub(board.running_count());
    if slots == 0 {
        return Vec::new();
    }
    let mut running = board.running_count_by_project();
    let mut selected = Vec::new();
    for card in board
        .cards
        .iter()
        .filter(|card| card.column == CardColumn::Ready)
    {
        if slots == 0 {
            break;
        }
        let used = running.entry(project_key(&card.working_dir)).or_default();
        if *used >= config.max_concurrent_cards_per_project {
            continue;
        }
        *used += 1;
        slots -= 1;
        selected.push(card.id.clone());
    }
    selected
}

async fn run_card(runtime: Arc<KanbanRuntime>, card_id: String) {
    let _guard = LiveCardGuard {
        runtime: Arc::clone(&runtime),
        card_id: card_id.clone(),
    };
    if let Err(error) = runtime.execute_card(&card_id).await {
        tracing::warn!(card_id = %card_id, error = %error, "kanban card execution failed");
        if let Err(handling_error) = runtime.handle_failure(&card_id, &error.to_string()).await {
            tracing::warn!(
                card_id = %card_id,
                error = %handling_error,
                "kanban card failure could not be handled"
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn card(working_dir: &str, column: CardColumn) -> Card {
        Card::new("t".into(), "b".into(), working_dir.into(), column)
    }

    fn board(cards: Vec<Card>) -> Board {
        Board { cards }
    }

    #[test]
    fn different_projects_are_claimed_in_the_same_tick() {
        let board = board(vec![
            card("/tmp/kanban-project-a", CardColumn::Ready),
            card("/tmp/kanban-project-b", CardColumn::Ready),
        ]);
        let selected = select_claimable(&board, &KanbanConfig::default());
        assert_eq!(selected.len(), 2, "不同项目的卡片必须能同时被领取");
    }

    #[test]
    fn cards_in_the_same_project_stay_serialized() {
        let board = board(vec![
            card("/tmp/kanban-project-a", CardColumn::Ready),
            card("/tmp/kanban-project-a", CardColumn::Ready),
        ]);
        let selected = select_claimable(&board, &KanbanConfig::default());
        assert_eq!(selected, vec![board.cards[0].id.clone()]);
    }

    #[test]
    fn global_cap_still_limits_total_concurrency() {
        let board = board(vec![
            card("/tmp/kanban-project-a", CardColumn::Ready),
            card("/tmp/kanban-project-b", CardColumn::Ready),
            card("/tmp/kanban-project-c", CardColumn::Ready),
        ]);
        let config = KanbanConfig {
            max_concurrent_cards: 2,
            ..KanbanConfig::default()
        };
        assert_eq!(select_claimable(&board, &config).len(), 2);
    }

    #[test]
    fn running_cards_consume_their_project_slot() {
        let board = board(vec![
            card("/tmp/kanban-project-a", CardColumn::Implementing),
            card("/tmp/kanban-project-a", CardColumn::Ready),
            card("/tmp/kanban-project-b", CardColumn::Ready),
        ]);
        let selected = select_claimable(&board, &KanbanConfig::default());
        assert_eq!(selected, vec![board.cards[2].id.clone()]);
    }

    #[test]
    fn terminal_and_idle_columns_do_not_consume_slots() {
        let board = board(vec![
            card("/tmp/kanban-project-a", CardColumn::Done),
            card("/tmp/kanban-project-a", CardColumn::Blocked),
            card("/tmp/kanban-project-a", CardColumn::Backlog),
            card("/tmp/kanban-project-a", CardColumn::Ready),
        ]);
        let selected = select_claimable(&board, &KanbanConfig::default());
        assert_eq!(selected.len(), 1, "终态与待办卡片不占用项目额度");
    }
}
