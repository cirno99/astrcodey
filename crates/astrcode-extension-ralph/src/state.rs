//! Ralph 循环状态：会话级落盘。
//!
//! 状态文件在 `<session_data_dir>/loops/<name>.json`。任务文件**不在这里**——它是给人看、
//! 给人改的产物，放在工作区 `.ralph/<name>.md`。

use std::path::{Path, PathBuf};

use astrcode_extension_sdk::hostpaths;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 状态文件所在目录。
pub(crate) fn loops_dir_from_base(base: &Path) -> PathBuf {
    base.join("loops")
}

const LOOP_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LoopStatus {
    /// 正在推进。
    Active,
    /// 被 `/ralph stop` 暂停；`/ralph start` 同名可接着跑。
    Paused,
    /// 命中完成承诺。
    Completed,
    /// 命中迭代上限或熔断。
    Stopped,
}

impl LoopStatus {
    pub(crate) fn allows_advance(self) -> bool {
        self == Self::Active
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Active => "进行中",
            Self::Paused => "已暂停",
            Self::Completed => "已完成",
            Self::Stopped => "已停止",
        }
    }
}

/// 循环停下的原因。每个变体都对应一个可命名的触发条件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StopReason {
    PromiseMatched,
    CapReached,
    NoProgress,
    Idle,
    TaskFileUnreadable,
    InjectFailed,
}

impl StopReason {
    pub(crate) fn text(self) -> &'static str {
        match self {
            Self::PromiseMatched => "命中完成承诺",
            Self::CapReached => "到达迭代上限",
            Self::NoProgress => "复读熔断：续跑没有产生新内容",
            Self::Idle => "空转熔断：续跑没有调用任何工具",
            Self::TaskFileUnreadable => "任务文件读不到",
            Self::InjectFailed => "注入下一轮提示失败",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LoopState {
    pub(crate) schema_version: u32,
    pub(crate) name: String,
    pub(crate) status: LoopStatus,
    /// 已经注入过多少轮提示；本轮提示的序号即此值。
    pub(crate) iteration: u32,
    /// 迭代上限；0 表示无限（只在显式传 `--max 0` 时出现）。
    pub(crate) max_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) completion_promise: Option<String>,
    /// 任务文件相对工作区的路径。
    pub(crate) task_file: String,
    /// 连续多少轮续跑没有调用工具。
    pub(crate) idle_streak: u32,
    /// 连续多少轮续跑既没有工具调用、回复又与上一轮相同（或为空）。
    pub(crate) no_progress_streak: u32,
    /// 上一轮回复文本的稳定指纹，用于复读判定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_text_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stop_reason: Option<StopReason>,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

impl LoopState {
    pub(crate) fn new(
        name: String,
        task_file: String,
        max_iterations: u32,
        completion_promise: Option<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            schema_version: LOOP_SCHEMA_VERSION,
            name,
            status: LoopStatus::Active,
            iteration: 0,
            max_iterations,
            completion_promise,
            task_file,
            idle_streak: 0,
            no_progress_streak: 0,
            last_text_fingerprint: None,
            stop_reason: None,
            started_at: now,
            updated_at: now,
        }
    }

    pub(crate) fn touch(&mut self) {
        self.updated_at = Utc::now();
    }

    pub(crate) fn set_status(&mut self, status: LoopStatus, reason: Option<StopReason>) {
        self.status = status;
        self.stop_reason = reason;
        self.touch();
    }

    /// 人工插话后重置熔断链：人给了新信息，之前积累的空转/复读不算数了。
    ///
    /// 迭代计数不动——预算是预算，插话不重置它。
    pub(crate) fn reset_breakers(&mut self) {
        self.idle_streak = 0;
        self.no_progress_streak = 0;
        self.last_text_fingerprint = None;
        self.touch();
    }
}

pub(crate) struct LoopStore {
    root: PathBuf,
}

impl LoopStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn state_path(&self, name: &str) -> PathBuf {
        self.root.join(format!("{name}.json"))
    }

    /// 按名字读取；状态文件不存在返回 `Ok(None)`。
    pub(crate) fn load(&self, name: &str) -> Result<Option<LoopState>, String> {
        self.read_state(&self.state_path(name))
    }

    /// 当前会话该推进的循环：优先活跃的那个，否则最近更新过的那个。
    ///
    /// 一个会话同时只允许一个活跃循环。磁盘上出现多个活跃状态说明状态被外部改坏，
    /// 此时返回错误而不是随便挑一个——静默挑一个会让 `/ralph cancel` 打错目标。
    pub(crate) fn load_current(&self) -> Result<Option<LoopState>, String> {
        let states = self.load_all()?;
        let active = {
            let mut active = states.iter().filter(|state| state.status.allows_advance());
            let first = active.next().cloned();
            if let Some(candidate) = &first
                && active.next().is_some()
            {
                return Err(format!(
                    "本会话存在多个活跃循环（含 `{}`）：请用 `/ralph cancel <name>` 清理",
                    candidate.name
                ));
            }
            first
        };
        Ok(active.or_else(|| states.into_iter().max_by_key(|state| state.updated_at)))
    }

    fn load_all(&self) -> Result<Vec<LoopState>, String> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("读取循环状态目录失败：{error}")),
        };
        let mut states = Vec::new();
        for entry in entries {
            let path = entry
                .map_err(|error| format!("读取循环状态目录失败：{error}"))?
                .path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Some(state) = self.read_state(&path)? {
                states.push(state);
            }
        }
        Ok(states)
    }

    fn read_state(&self, path: &Path) -> Result<Option<LoopState>, String> {
        let state = hostpaths::read_json_state::<LoopState>(path)
            .map_err(|error| format!("读取循环状态 {} 失败：{error}", path.display()))?;
        if let Some(state) = &state
            && state.schema_version != LOOP_SCHEMA_VERSION
        {
            return Err(format!(
                "循环状态 {} 的 schema 版本 {} 不受支持（期望 {LOOP_SCHEMA_VERSION}）",
                path.display(),
                state.schema_version
            ));
        }
        Ok(state)
    }

    pub(crate) fn save(&self, state: &LoopState) -> Result<(), String> {
        hostpaths::write_json_state(&self.state_path(&state.name), state)
            .map_err(|error| format!("保存循环状态失败：{error}"))
    }

    pub(crate) fn remove(&self, name: &str) -> Result<(), String> {
        match std::fs::remove_file(self.state_path(name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除循环状态失败：{error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &tempfile::TempDir) -> LoopStore {
        LoopStore::new(dir.path().to_path_buf())
    }

    fn state(name: &str) -> LoopState {
        LoopState::new(name.into(), format!(".ralph/{name}.md"), 50, None)
    }

    #[test]
    fn state_round_trips_and_reports_unsupported_schema() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let saved = LoopState::new(
            "fix-tests".into(),
            ".ralph/fix-tests.md".into(),
            50,
            Some("DONE".into()),
        );
        store.save(&saved).unwrap();
        assert_eq!(store.load("fix-tests").unwrap(), Some(saved));

        let mut unsupported = state("fix-tests");
        unsupported.schema_version = LOOP_SCHEMA_VERSION + 1;
        store.save(&unsupported).unwrap();
        assert!(store.load("fix-tests").unwrap_err().contains("schema"));
    }

    #[test]
    fn corrupt_state_is_an_error_not_an_empty_loop() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save(&state("x")).unwrap();
        std::fs::write(dir.path().join("x.json"), "{ not json").unwrap();
        assert!(store.load("x").is_err());
        assert!(store.load_current().is_err());
    }

    #[test]
    fn current_prefers_active_and_rejects_two_active_loops() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);

        let mut paused = state("a");
        paused.set_status(LoopStatus::Paused, None);
        store.save(&paused).unwrap();
        assert_eq!(store.load_current().unwrap().unwrap().name, "a");

        store.save(&state("b")).unwrap();
        assert_eq!(store.load_current().unwrap().unwrap().name, "b");

        store.save(&state("c")).unwrap();
        assert!(store.load_current().unwrap_err().contains("多个活跃循环"));
    }
}
