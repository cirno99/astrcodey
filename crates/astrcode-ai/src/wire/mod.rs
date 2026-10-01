//! Wire-level codecs and request builders.
//!
//! Provider wrappers own lifecycle and transport orchestration; wire modules own protocol shape.

pub(crate) mod anthropic;
pub(crate) mod openai;

/// 判定 provider 在流内下发的错误事件是否属于可重放的瞬态中断。
///
/// 只在结构化 `type`/`code` 明确表示「重试无意义」时才判为永久错误，无法识别的一律按瞬态
/// 处理（与 `astrcode-extension-kanban` 的失败分类同向）：最多多烧两次重试预算，不会损坏数据。
pub(crate) fn is_transient_stream_error(event: &serde_json::Value) -> bool {
    const PERMANENT: [&str; 8] = [
        "invalid_request_error",
        "authentication_error",
        "permission_error",
        "not_found_error",
        "insufficient_quota",
        "billing_error",
        "context_length_exceeded",
        "content_filter",
    ];
    let kind = event
        .pointer("/error/type")
        .or_else(|| event.pointer("/error/code"))
        .or_else(|| event.pointer("/response/error/type"))
        .or_else(|| event.pointer("/response/error/code"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    !PERMANENT.contains(&kind)
}
