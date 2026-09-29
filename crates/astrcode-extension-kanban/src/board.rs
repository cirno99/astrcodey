//! 看板数据模型与持久化。
//!
//! 看板是扩展自有的数据，落在扩展全局数据目录下的 `board.json`。
//! 所有读写都经过 [`BoardStore`]，由它串行化读-改-写并保证磁盘是唯一事实来源。

use std::{
    collections::HashMap,
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
    /// 卡片在日历上的归属日（`YYYY-MM-DD`）。
    ///
    /// 创建时取创建当天，用户可以拖拽改写；空串表示旧数据的 `created_at` 无法解析，
    /// 归属日未知——不静默塞一个今天进去。
    #[serde(default)]
    pub date: String,
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
            date: day_from_rfc3339(&now).unwrap_or_default(),
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

/// 卡片的工作目录归属键。
///
/// 同一项目的不同写法（尾斜杠、符号链接）必须归到同一个键，否则「同项目串行」会在
/// 两个键之间失效。目录不存在时回退到原字符串：那种卡片本来就建不了 session，
/// 不该在调度阶段把它变成错误。
pub fn project_key(working_dir: &str) -> String {
    fs::canonicalize(working_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| working_dir.to_string())
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

    /// 按工作目录聚合运行中卡片数，供「同项目串行」判定使用。
    pub fn running_count_by_project(&self) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for card in self.cards.iter().filter(|card| card.column.is_running()) {
            *counts.entry(project_key(&card.working_dir)).or_default() += 1;
        }
        counts
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
    #[error("归属日 {0} 不是合法的 YYYY-MM-DD 日期")]
    InvalidDay(String),
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
            Ok(bytes) => {
                let mut board: Board = serde_json::from_slice(&bytes)?;
                backfill_dates(&mut board);
                Ok(board)
            },
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

/// 补齐早于 `date` 字段写下的看板文件。
///
/// 只在内存里补，下一次写盘自然落盘。`created_at` 也解析不了的卡片保持空串：
/// 那是无法确定归属日的旧数据，编一个今天出来只会把损坏伪装成正常。
fn backfill_dates(board: &mut Board) {
    for card in &mut board.cards {
        if card.date.is_empty() {
            card.date = day_from_rfc3339(&card.created_at).unwrap_or_default();
        }
    }
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// RFC3339 时间戳转日历日 `YYYY-MM-DD`。
///
/// 取本地日历日：日历是给人看的，前端 `dayKeyFromIso` 也按本地时区换算，
/// 两边用同一个时区，凌晨创建的卡片才不会落到前一天。
/// 时间戳无法解析时返回 `None`，由调用方决定是留空还是报错。
pub fn day_from_rfc3339(timestamp: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|value| {
            value
                .with_timezone(&chrono::Local)
                .date_naive()
                .format("%Y-%m-%d")
                .to_string()
        })
}

/// 校验用户传入的归属日。
///
/// 归属日跨 HTTP 边界进入持久化文件，必须在边界上确认它是真实的日历日，
/// 否则日历会拿到一个无法分桶的字符串。
pub fn parse_day(value: &str) -> Result<String, BoardStoreError> {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|day| day.format("%Y-%m-%d").to_string())
        .map_err(|_| BoardStoreError::InvalidDay(value.to_string()))
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone as _;

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
        // 归属日按本地日历回填，写死 UTC 字符串会在西半球时区变成前一天。
        let created_at = chrono::Local
            .with_ymd_and_hms(2026, 1, 1, 0, 30, 0)
            .single()
            .expect("本地凌晨必须存在")
            .to_rfc3339();
        let legacy = serde_json::json!({
            "cards": [{
                "id": "legacy-card",
                "title": "旧卡片",
                "body": "",
                "column": "ready",
                "workingDir": "/tmp/project",
                "attempt": 1,
                "createdAt": created_at.clone(),
                "updatedAt": created_at.clone(),
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
        assert_eq!(
            card.date, "2026-01-01",
            "缺 date 的旧卡片按 created_at 回填"
        );
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
    /// 归属日无法从 `created_at` 推导时保持空串，不能悄悄认领今天。
    #[test]
    fn backfill_leaves_unknown_dates_empty_instead_of_guessing_today() {
        let (dir, store) = store();
        let legacy = serde_json::json!({
            "cards": [{
                "id": "broken-card",
                "title": "时间戳损坏",
                "body": "",
                "column": "backlog",
                "workingDir": "/tmp/project",
                "attempt": 0,
                "createdAt": "not-a-timestamp",
                "updatedAt": "not-a-timestamp"
            }]
        });
        fs::write(
            dir.path().join(BOARD_FILE),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let card = store
            .read(|board| board.card("broken-card").cloned())
            .unwrap()
            .expect("卡片仍必须可读");
        assert!(card.date.is_empty(), "无法确定归属日时不能编一个日期出来");
    }

    #[test]
    fn parse_day_accepts_real_days_and_rejects_everything_else() {
        assert_eq!(parse_day("2026-02-28").unwrap(), "2026-02-28");
        assert_eq!(
            parse_day("2026-2-3").unwrap(),
            "2026-02-03",
            "非补零输入要归一化"
        );
        assert!(parse_day("2026-02-30").is_err(), "不存在的日历日必须被拒");
        assert!(parse_day("").is_err());
        assert!(parse_day("2026-01-01T00:00:00Z").is_err());
    }

    #[test]
    fn new_card_starts_on_its_creation_day() {
        let card = sample_card();
        assert_eq!(card.date, day_from_rfc3339(&card.created_at).unwrap());
    }

    /// 归属日取本地日历日，而不是直接截 UTC 日期。
    ///
    /// 本地凌晨在东半球时区已经跨到 UTC 的前一天，截 UTC 会把卡片排到昨天；
    /// 前端 `dayKeyFromIso` 也按本地时区换算，两边必须给出同一天。
    #[test]
    fn day_from_rfc3339_uses_the_local_calendar() {
        let local_after_midnight = chrono::Local
            .with_ymd_and_hms(2026, 6, 15, 0, 30, 0)
            .single()
            .expect("本地凌晨必须存在");
        assert_eq!(
            day_from_rfc3339(&local_after_midnight.to_rfc3339()),
            Some("2026-06-15".to_string())
        );
    }
}
