//! 看板扩展配置。

use astrcode_extension_sdk::{WireErrorCode, extension::ExtensionError};
use serde::{Deserialize, Serialize};

const MIN_POLL_INTERVAL_SECS: u64 = 5;
const MIN_MAX_CONCURRENT_CARDS: usize = 1;
const MIN_MAX_ATTEMPTS_PER_CARD: u32 = 1;
const MIN_MAX_CONTINUATIONS_PER_TURN: u32 = 1;
const MIN_MAX_ERROR_RETRIES_PER_CARD: u32 = 1;

/// `extensions.astrcode-kanban` 的配置形状。
///
/// 扩展启用状态与自动化开关相互独立：启用插件只让看板页出现，是否自动推进由
/// `automationEnabled` 决定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KanbanConfig {
    #[serde(default)]
    pub automation_enabled: bool,
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_max_concurrent_cards")]
    pub max_concurrent_cards: usize,
    #[serde(default = "default_max_attempts_per_card")]
    pub max_attempts_per_card: u32,
    #[serde(default = "default_max_continuations_per_turn")]
    pub max_continuations_per_turn: u32,
    /// 同一张卡片允许的执行失败重试次数，与 `maxAttemptsPerCard`（实施轮次）语义分离。
    #[serde(default = "default_max_error_retries_per_card")]
    pub max_error_retries_per_card: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_working_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyze_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub implement_prompt: Option<String>,
}

impl Default for KanbanConfig {
    fn default() -> Self {
        Self {
            automation_enabled: false,
            poll_interval_secs: default_poll_interval_secs(),
            max_concurrent_cards: default_max_concurrent_cards(),
            max_attempts_per_card: default_max_attempts_per_card(),
            max_continuations_per_turn: default_max_continuations_per_turn(),
            max_error_retries_per_card: default_max_error_retries_per_card(),
            default_working_dir: None,
            analyze_prompt: None,
            implement_prompt: None,
        }
    }
}

const fn default_poll_interval_secs() -> u64 {
    30
}

const fn default_max_concurrent_cards() -> usize {
    1
}

const fn default_max_attempts_per_card() -> u32 {
    10
}

/// 无人值守希望单轮尽可能长，默认直接开到硬闸门；再往上要改 [`crate::HARD_CONTINUATION_LIMIT`]。
const fn default_max_continuations_per_turn() -> u32 {
    crate::HARD_CONTINUATION_LIMIT
}

const fn default_max_error_retries_per_card() -> u32 {
    3
}

impl KanbanConfig {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        if self.poll_interval_secs < MIN_POLL_INTERVAL_SECS {
            return Err(invalid(
                "pollIntervalSecs",
                format!("轮询间隔不得小于 {MIN_POLL_INTERVAL_SECS} 秒"),
            ));
        }
        if self.max_concurrent_cards < MIN_MAX_CONCURRENT_CARDS {
            return Err(invalid(
                "maxConcurrentCards",
                "并发卡片数至少为 1".to_string(),
            ));
        }
        if self.max_attempts_per_card < MIN_MAX_ATTEMPTS_PER_CARD {
            return Err(invalid(
                "maxAttemptsPerCard",
                "每张卡片的尝试次数至少为 1".to_string(),
            ));
        }
        if self.max_continuations_per_turn < MIN_MAX_CONTINUATIONS_PER_TURN {
            return Err(invalid(
                "maxContinuationsPerTurn",
                "单轮续跑次数至少为 1".to_string(),
            ));
        }
        if self.max_error_retries_per_card < MIN_MAX_ERROR_RETRIES_PER_CARD {
            return Err(invalid(
                "maxErrorRetriesPerCard",
                "每张卡片的失败重试次数至少为 1".to_string(),
            ));
        }
        if let Some(dir) = &self.default_working_dir
            && dir.trim().is_empty()
        {
            return Err(invalid(
                "defaultWorkingDir",
                "默认工作目录不能是空白字符串".to_string(),
            ));
        }
        Ok(())
    }

    pub fn analyze_prompt(&self) -> &str {
        self.analyze_prompt
            .as_deref()
            .unwrap_or(crate::prompt::DEFAULT_ANALYZE_PROMPT)
    }

    pub fn implement_prompt(&self) -> &str {
        self.implement_prompt
            .as_deref()
            .unwrap_or(crate::prompt::DEFAULT_IMPLEMENT_PROMPT)
    }
}

fn invalid(path: &str, message: String) -> ExtensionError {
    ExtensionError::InvalidInput {
        code: WireErrorCode::InvalidInput.as_str().into(),
        message: format!("astrcode-kanban 配置项 {path} 无效: {message}"),
        hint: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_config_yields_defaults() {
        let config = KanbanConfig::default();
        assert!(!config.automation_enabled);
        assert_eq!(config.poll_interval_secs, 30);
        assert_eq!(config.max_concurrent_cards, 1);
        assert_eq!(config.max_attempts_per_card, 10);
        assert_eq!(
            config.max_continuations_per_turn,
            crate::HARD_CONTINUATION_LIMIT
        );
        assert_eq!(config.max_error_retries_per_card, 3);
        config.validate().expect("defaults must be valid");
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let error = serde_json::from_value::<KanbanConfig>(serde_json::json!({
            "unexpected": true
        }))
        .expect_err("unknown fields must be rejected");
        assert!(error.to_string().contains("unexpected"));
    }

    #[test]
    fn out_of_range_values_are_rejected_by_validation() {
        let cases = [
            (
                KanbanConfig {
                    poll_interval_secs: 0,
                    ..KanbanConfig::default()
                },
                "pollIntervalSecs",
            ),
            (
                KanbanConfig {
                    max_concurrent_cards: 0,
                    ..KanbanConfig::default()
                },
                "maxConcurrentCards",
            ),
            (
                KanbanConfig {
                    max_attempts_per_card: 0,
                    ..KanbanConfig::default()
                },
                "maxAttemptsPerCard",
            ),
            (
                KanbanConfig {
                    max_continuations_per_turn: 0,
                    ..KanbanConfig::default()
                },
                "maxContinuationsPerTurn",
            ),
            (
                KanbanConfig {
                    max_error_retries_per_card: 0,
                    ..KanbanConfig::default()
                },
                "maxErrorRetriesPerCard",
            ),
            (
                KanbanConfig {
                    default_working_dir: Some("   ".into()),
                    ..KanbanConfig::default()
                },
                "defaultWorkingDir",
            ),
        ];

        for (config, path) in cases {
            let error = config.validate().expect_err("config must be rejected");
            assert!(error.to_string().contains(path), "{error}");
        }
    }

    #[test]
    fn custom_prompts_override_built_in_defaults() {
        let config = KanbanConfig {
            analyze_prompt: Some("自定义分析".into()),
            implement_prompt: Some("自定义实施".into()),
            ..KanbanConfig::default()
        };
        assert_eq!(config.analyze_prompt(), "自定义分析");
        assert_eq!(config.implement_prompt(), "自定义实施");
    }
}
