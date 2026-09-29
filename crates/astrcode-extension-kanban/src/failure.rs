//! 执行失败的分类与处置决策。
//!
//! 宿主把 turn 失败作为错误文本交给扩展（`HostError` 只带消息），所以分类只能基于文本。
//! 这是「扩展侧文本分类」这一取舍的代价：宿主侧文案变化会让分类静默降级为
//! [`FailureKind::Transient`]，最多多烧几次重试预算再置 `blocked`，不会损坏数据。
//!
//! 退化重复的文案前缀由 `crates/astrcode-session/src/repetition_guard.rs` 固定，
//! 扩展无法引用该常量（内置插件只能依赖插件系统），故此处按字面量匹配。

/// 失败的分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureKind {
    /// 模型陷入重复输出，守卫中断了生成。
    Degenerate,
    /// 传输层抖动、限流、5xx 等可重试失败。
    Transient,
    /// 模型不存在、鉴权失败、配额耗尽等重试无意义的失败。
    Permanent,
}

/// 对一张卡片的处置动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CardAction {
    /// 保留 session，退回待领取后重投实施。
    RetrySameSession,
    /// 回收旧 session，回到分析阶段重做。
    RestartSession,
    /// 置为终态，等待人工介入。
    Block,
}

/// 退化重复文案的稳定前缀，与 `astrcode-session` 的守卫常量保持一致。
const DEGENERATE_MARKER: &str = "degenerate repetition detected";

/// 可重试失败的文本特征。
const TRANSIENT_MARKERS: [&str; 14] = [
    "transport",
    "timed out",
    "timeout",
    "connection reset",
    "connection refused",
    "broken pipe",
    "stream ended unexpectedly",
    "terminated by the server",
    "status=429",
    "rate limit",
    "status=500",
    "status=502",
    "status=503",
    "status=504",
];

/// 重试无意义的失败文本特征。
const PERMANENT_MARKERS: [&str; 9] = [
    "model not found",
    "404 page not found",
    "status=401",
    "status=403",
    "status=404",
    "unauthorized",
    "invalid api key",
    "quota",
    "insufficient",
];

/// 按错误文本判定失败类型。无法识别的一律按可重试处理。
pub(crate) fn classify_failure(message: &str) -> FailureKind {
    let message = message.to_lowercase();
    if message.contains(DEGENERATE_MARKER) {
        return FailureKind::Degenerate;
    }
    if PERMANENT_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return FailureKind::Permanent;
    }
    if TRANSIENT_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
    {
        return FailureKind::Transient;
    }
    FailureKind::Transient
}

/// 决定这张卡片接下来怎么处置。
pub(crate) fn next_action(
    kind: FailureKind,
    error_retries: u32,
    max_error_retries: u32,
) -> CardAction {
    if error_retries >= max_error_retries {
        return CardAction::Block;
    }
    match kind {
        FailureKind::Degenerate => CardAction::RestartSession,
        FailureKind::Transient => CardAction::RetrySameSession,
        FailureKind::Permanent => CardAction::Block,
    }
}

/// 失败类型的中文标签，用于写进卡片 `note`。
pub(crate) fn kind_label(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Degenerate => "模型重复输出",
        FailureKind::Transient => "可重试失败",
        FailureKind::Permanent => "不可重试失败",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用户实际遇到的四条错误原文。
    #[test]
    fn real_world_errors_are_classified_as_expected() {
        let cases = [
            (
                "transport error: read streaming response body failed for \
                 https://api.r4.codes/v1/chat/completions: status=200, content-type=text/event-stream, \
                 content-encoding=<missing>, bytes-read=1329670: error decoding response body; caused by: \
                 request or response body error; caused by: error reading a body from connection; caused \
                 by: Connection timed out (os error 110)",
                FailureKind::Transient,
            ),
            (
                "transport error: read streaming response body failed for \
                 https://api.r4.codes/v1/chat/completions: status=200, content-type=text/event-stream, \
                 content-encoding=<missing>, bytes-read=267384: error decoding response body; caused by: \
                 request or response body error; caused by: error reading a body from connection; caused \
                 by: Connection reset by peer (os error 104)",
                FailureKind::Transient,
            ),
            (
                "The stream was terminated by the server. Please retry.",
                FailureKind::Transient,
            ),
            (
                "model not found (404): 404 page not found",
                FailureKind::Permanent,
            ),
        ];

        for (message, expected) in cases {
            assert_eq!(classify_failure(message), expected, "误判: {message}");
        }
    }

    #[test]
    fn degenerate_repetition_is_recognized_by_its_marker() {
        assert_eq!(
            classify_failure(
                "degenerate repetition detected: 40 lines contained only 13 distinct lines"
            ),
            FailureKind::Degenerate
        );
    }

    #[test]
    fn unknown_errors_stay_retryable() {
        assert_eq!(
            classify_failure("something nobody has seen before"),
            FailureKind::Transient
        );
    }

    #[test]
    fn retry_budget_exhaustion_blocks_regardless_of_kind() {
        for kind in [
            FailureKind::Transient,
            FailureKind::Degenerate,
            FailureKind::Permanent,
        ] {
            assert_eq!(next_action(kind, 3, 3), CardAction::Block);
            assert_eq!(next_action(kind, 4, 3), CardAction::Block);
        }
    }

    #[test]
    fn actions_follow_the_failure_kind_within_budget() {
        assert_eq!(
            next_action(FailureKind::Transient, 0, 3),
            CardAction::RetrySameSession
        );
        assert_eq!(
            next_action(FailureKind::Degenerate, 0, 3),
            CardAction::RestartSession
        );
        assert_eq!(next_action(FailureKind::Permanent, 0, 3), CardAction::Block);
    }
}
