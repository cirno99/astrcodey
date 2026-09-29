//! 看板数据模型与持久化。
//!
//! 看板是扩展自有的数据，落在扩展全局数据目录下的 `board.json`。
//! 所有读写都经过 [`BoardStore`]，由它串行化读-改-写并保证磁盘是唯一事实来源。

use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const BOARD_FILE: &str = "board.json";

/// 卡片在看板上的列。
///
/// 终态列不会再被自动化领取；运行中列由扩展独占写入，用户与 agent 都不能直接设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardColumn {
    Backlog,
    Ready,
    Analyzing,
    Implementing,
    Done,
    Blocked,
}

impl CardColumn {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Blocked)
    }

    pub fn is_running(self) -> bool {
        matches!(self, Self::Analyzing | Self::Implementing)
    }
}

/// 一张需求卡片。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub column: CardColumn,
    pub working_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub attempt: u32,
    /// 执行失败（不含正常轮次推进）的重试次数；与 `attempt` 语义分离，见 `failure` 模块。
    #[serde(default)]
    pub error_retries: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Card {
    pub fn new(title: String, body: String, working_dir: String, column: CardColumn) -> Self {
        let now = now_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            body,
            column,
            working_dir,
            session_id: None,
            attempt: 0,
            error_retries: 0,
            note: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Board {
    #[serde(default)]
    pub cards: Vec<Card>,
}

impl Board {
    pub fn card(&self, card_id: &str) -> Option<&Card> {
        self.cards.iter().find(|card| card.id == card_id)
    }

    pub fn card_by_session(&self, session_id: &str) -> Option<&Card> {
        self.cards
            .iter()
            .find(|card| card.session_id.as_deref() == Some(session_id))
    }

    pub fn running_count(&self) -> usize {
        self.cards
            .iter()
            .filter(|card| card.column.is_running())
            .count()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BoardStoreError {
    #[error("看板文件读写失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("看板文件解析失败: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("看板文件序列化失败: {0}")]
    Encode(serde_json::Error),
    #[error("未找到卡片 {0}")]
    CardNotFound(String),
    #[error("卡片 {card_id} 属于其他会话，当前会话无权修改")]
    CardNotOwned { card_id: String },
    #[error("卡片 {card_id} 处于运行中列，无法直接修改")]
    CardRunning { card_id: String },
}

/// 看板文件访问器。
///
/// 磁盘是唯一事实来源：每次读写都重新解析文件，锁只用于串行化同一进程内的读-改-写，
/// 避免 HTTP 请求与自动化循环互相覆盖。
pub struct BoardStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl BoardStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(BOARD_FILE),
            lock: Mutex::new(()),
        }
    }

    /// 读取看板的一致性快照。
    pub fn read<T>(&self, view: impl FnOnce(&Board) -> T) -> Result<T, BoardStoreError> {
        let _guard = self.lock.lock();
        let board = self.load_locked()?;
        Ok(view(&board))
    }

    /// 在读-改-写窗口内独占访问看板，闭包成功返回后写回磁盘。
    pub fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Board) -> Result<T, BoardStoreError>,
    ) -> Result<T, BoardStoreError> {
        let _guard = self.lock.lock();
        let mut board = self.load_locked()?;
        let output = change(&mut board)?;
        self.save_locked(&board)?;
        Ok(output)
    }

    fn load_locked(&self) -> Result<Board, BoardStoreError> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Board::default()),
            Err(error) => Err(BoardStoreError::Io(error)),
        }
    }

    fn save_locked(&self, board: &Board) -> Result<(), BoardStoreError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| BoardStoreError::Io(std::io::Error::other("看板文件路径缺少父目录")))?;
        fs::create_dir_all(parent)?;

        let temporary = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(board).map_err(BoardStoreError::Encode)?;
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, BoardStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = BoardStore::new(dir.path());
        (dir, store)
    }

    fn sample_card() -> Card {
        Card::new(
            "接入看板".into(),
            "把需求写成卡片".into(),
            "/tmp/project".into(),
            CardColumn::Ready,
        )
    }

    #[test]
    fn missing_board_reads_as_empty_and_round_trips() {
        let (_dir, store) = store();
        assert!(store.read(|board| board.cards.len()).unwrap() == 0);

        let card = sample_card();
        store
            .mutate(|board| {
                board.cards.push(card.clone());
                Ok(())
            })
            .unwrap();

        let loaded = store
            .read(|board| board.card(&card.id).cloned())
            .unwrap()
            .expect("card should survive a round trip");
        assert_eq!(loaded, card);
    }

    #[test]
    fn corrupt_board_surfaces_a_typed_error_instead_of_an_empty_board() {
        let (dir, store) = store();
        fs::write(dir.path().join(BOARD_FILE), b"{ not json").unwrap();

        let error = store
            .read(|board| board.cards.len())
            .expect_err("corrupt board must not degrade into an empty board");
        assert!(matches!(error, BoardStoreError::Decode(_)));
    }

    /// 早于 `error_retries` 的看板文件必须仍可读，缺字段取 0。
    #[test]
    fn board_without_error_retries_still_loads() {
        let (dir, store) = store();
        let legacy = serde_json::json!({
            "cards": [{
                "id": "legacy-card",
                "title": "旧卡片",
                "body": "",
                "column": "ready",
                "workingDir": "/tmp/project",
                "attempt": 1,
                "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-01T00:00:00+00:00"
            }]
        });
        fs::write(
            dir.path().join(BOARD_FILE),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let card = store
            .read(|board| board.card("legacy-card").cloned())
            .unwrap()
            .expect("旧看板必须仍可读");
        assert_eq!(card.error_retries, 0);
        assert_eq!(card.attempt, 1);
    }

    #[test]
    fn running_count_ignores_terminal_and_idle_columns() {
        let mut board = Board::default();
        for column in [
            CardColumn::Backlog,
            CardColumn::Ready,
            CardColumn::Analyzing,
            CardColumn::Implementing,
            CardColumn::Done,
            CardColumn::Blocked,
        ] {
            let mut card = sample_card();
            card.column = column;
            board.cards.push(card);
        }
        assert_eq!(board.running_count(), 2);
    }
}
