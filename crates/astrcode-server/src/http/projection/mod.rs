//! Event → DTO 投影。
//!
//! 子模块按职责切分：
//! - `args`: 工具参数 → 折叠摘要文本。
//! - `blocks`: payload/message → ConversationBlockDto。
//! - `live`: 实时 event → ConversationDeltaDto。
//! - `replay`: 历史 event → ConversationDeltaDto。
//! - `snapshot`: session read model → ConversationSnapshotResponseDto。

use std::collections::BTreeMap;

use astrcode_protocol::http::ConversationMetricsDto;
use astrcode_session_projection::SessionMetrics;

pub(in crate::http) mod args;
pub(in crate::http) mod blocks;
pub(in crate::http) mod live;
pub(in crate::http) mod replay;
pub(in crate::http) mod snapshot;

pub(in crate::http) fn session_title_from_working_dir(working_dir: &str) -> String {
    std::path::Path::new(working_dir)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(working_dir)
        .to_string()
}

fn non_empty_metadata(metadata: &BTreeMap<String, serde_json::Value>) -> Option<serde_json::Value> {
    (!metadata.is_empty()).then(|| {
        serde_json::Value::Object(
            metadata
                .clone()
                .into_iter()
                .collect::<serde_json::Map<_, _>>(),
        )
    })
}

/// 会话指标读模型 → wire DTO。
pub(in crate::http) fn metrics_to_dto(metrics: &SessionMetrics) -> ConversationMetricsDto {
    ConversationMetricsDto {
        requests: metrics.requests,
        prompt_tokens: metrics.prompt_tokens,
        cached_tokens: metrics.cached_tokens,
        cache_creation_tokens: metrics.cache_creation_tokens,
        output_tokens: metrics.output_tokens,
        reasoning_output_tokens: metrics.reasoning_output_tokens,
        last_prompt_tokens: metrics.last_prompt_tokens,
        last_cached_tokens: metrics.last_cached_tokens,

        context_tokens: metrics
            .context_tokens
            .and_then(|tokens| u64::try_from(tokens).ok()),
        model_context_window: metrics
            .model_context_window
            .and_then(|tokens| u64::try_from(tokens).ok()),
        output_tokens_per_second: metrics
            .throughput
            .and_then(|throughput| throughput.output_tokens_per_second()),
    }
}
