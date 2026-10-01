//! 判据链与完成承诺解析。
//!
//! 判据顺序即优先级：完成承诺 → 迭代上限 → 复读熔断 → 空转熔断 → 继续。
//! 顺序不是风格问题：承诺是「任务真的做完了」，上限是「预算用完了」，熔断是「模型在空转」，
//! 三者同时命中时必须先报告前者。

use astrcode_extension_sdk::event::stable_hash_hex;

use crate::state::{LoopState, LoopStatus, StopReason};

/// 复读熔断阈值：连续多少轮「没有工具调用且回复重复或为空」就停。
pub(crate) const NO_PROGRESS_STOP: u32 = 1;

/// 空转熔断阈值：连续多少轮「没有工具调用」就停。
pub(crate) const IDLE_STOP: u32 = 3;

/// 一轮推进的观测输入。
pub(crate) struct Observation<'a> {
    pub(crate) assistant_text: &'a str,
    /// 自上次判定以来是否出现过工具调用。
    pub(crate) had_tool_call: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    /// 继续推进；调用方负责注入本轮提示。
    Continue,
    /// 停下，并给出原因。
    Stop(StopReason),
}

/// 推进一轮：先按本轮观测更新熔断链，再走判据链决定继续还是停下。
///
/// 只在 `Continue` 时递增 `iteration`——被熔断或上限拦下的那一轮没有真的跑过。
pub(crate) fn advance(state: &mut LoopState, observation: &Observation<'_>) -> Decision {
    let fingerprint = stable_hash_hex(&[observation.assistant_text]);
    let repeated = !observation.had_tool_call
        && (observation.assistant_text.trim().is_empty()
            || state.last_text_fingerprint.as_deref() == Some(fingerprint.as_str()));

    state.no_progress_streak = if repeated {
        state.no_progress_streak.saturating_add(1)
    } else {
        0
    };
    state.idle_streak = if observation.had_tool_call {
        0
    } else {
        state.idle_streak.saturating_add(1)
    };
    state.last_text_fingerprint = Some(fingerprint);

    if let Some(promise) = state.completion_promise.as_deref()
        && promise_matches(observation.assistant_text, promise)
    {
        state.set_status(LoopStatus::Completed, Some(StopReason::PromiseMatched));
        return Decision::Stop(StopReason::PromiseMatched);
    }

    if state.max_iterations > 0 && state.iteration >= state.max_iterations {
        state.set_status(LoopStatus::Stopped, Some(StopReason::CapReached));
        return Decision::Stop(StopReason::CapReached);
    }

    if state.no_progress_streak >= NO_PROGRESS_STOP {
        state.set_status(LoopStatus::Stopped, Some(StopReason::NoProgress));
        return Decision::Stop(StopReason::NoProgress);
    }

    if state.idle_streak >= IDLE_STOP {
        state.set_status(LoopStatus::Stopped, Some(StopReason::Idle));
        return Decision::Stop(StopReason::Idle);
    }

    state.iteration = state.iteration.saturating_add(1);
    state.touch();
    Decision::Continue
}

/// 文本里第一个 `<promise>` 标签的内容（去掉首尾空白）。
///
/// 只取第一个标签：Claude Code 的 stop hook 也是这个口径，多个标签时后面的不参与判定。
pub(crate) fn promise_value(text: &str) -> Option<&str> {
    const OPEN: &str = "<promise>";
    const CLOSE: &str = "</promise>";

    let rest = &text[text.find(OPEN)? + OPEN.len()..];
    let value = &rest[..rest.find(CLOSE)?];
    Some(value.trim())
}

/// 承诺串是否命中。字面量比较：不做大小写折叠、不解释通配符。
///
/// 标签内容先 `trim`——模型把承诺写成 `<promise>\nDONE\n</promise>` 是常见形态，
/// 而没有任何合法承诺是以空白区分的。
pub(crate) fn promise_matches(text: &str, expected: &str) -> bool {
    promise_value(text).is_some_and(|value| value == expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::LoopState;

    fn loop_state(max_iterations: u32, promise: Option<&str>) -> LoopState {
        LoopState::new(
            "t".into(),
            ".ralph/t.md".into(),
            max_iterations,
            promise.map(str::to_owned),
        )
    }

    fn observe(text: &str, had_tool_call: bool) -> Observation<'_> {
        Observation {
            assistant_text: text,
            had_tool_call,
        }
    }

    #[test]
    fn promise_takes_first_tag_and_compares_literally() {
        assert_eq!(promise_value("done <promise>DONE</promise>"), Some("DONE"));
        assert_eq!(
            promise_value("<promise>DONE</promise> then <promise>OTHER</promise>"),
            Some("DONE")
        );
        assert_eq!(promise_value("<promise>\n DONE \n</promise>"), Some("DONE"));
        assert_eq!(promise_value("no tag here"), None);
        assert_eq!(promise_value("<promise>unclosed"), None);

        assert!(promise_matches("<promise>DONE</promise>", "DONE"));
        assert!(!promise_matches("<promise>done</promise>", "DONE"));
        assert!(!promise_matches("<promise>DONE!</promise>", "DONE"));
        assert!(!promise_matches("DONE", "DONE"));
    }

    #[test]
    fn promise_wins_over_cap_and_breakers() {
        let mut state = loop_state(1, Some("DONE"));
        state.iteration = 1;

        assert_eq!(
            advance(&mut state, &observe("<promise>DONE</promise>", false)),
            Decision::Stop(StopReason::PromiseMatched)
        );
        assert_eq!(state.status, LoopStatus::Completed);
    }

    #[test]
    fn cap_wins_over_breakers_and_does_not_advance_iteration() {
        let mut state = loop_state(2, None);
        state.iteration = 2;

        assert_eq!(
            advance(&mut state, &observe("", false)),
            Decision::Stop(StopReason::CapReached)
        );
        assert_eq!(state.iteration, 2);
        assert_eq!(state.status, LoopStatus::Stopped);
    }

    #[test]
    fn repeated_text_without_tools_trips_no_progress() {
        let mut state = loop_state(50, None);
        assert_eq!(
            advance(&mut state, &observe("正在检查", false)),
            Decision::Continue
        );
        assert_eq!(
            advance(&mut state, &observe("正在检查", false)),
            Decision::Stop(StopReason::NoProgress)
        );
    }

    #[test]
    fn tool_calls_reset_both_breakers() {
        let mut state = loop_state(50, None);
        advance(&mut state, &observe("第一轮", false));
        advance(&mut state, &observe("第二轮", false));
        assert_eq!(state.idle_streak, 2);

        assert_eq!(
            advance(&mut state, &observe("第三轮", true)),
            Decision::Continue
        );
        assert_eq!(state.idle_streak, 0);
        assert_eq!(state.no_progress_streak, 0);
        assert_eq!(state.iteration, 3);
    }

    #[test]
    fn idle_breaker_trips_after_threshold_of_tool_free_rounds() {
        let mut state = loop_state(50, None);
        for round in 0..IDLE_STOP - 1 {
            assert_eq!(
                advance(&mut state, &observe(&format!("轮 {round}"), false)),
                Decision::Continue
            );
        }
        assert_eq!(
            advance(&mut state, &observe("最后一轮", false)),
            Decision::Stop(StopReason::Idle)
        );
    }

    #[test]
    fn zero_cap_means_unbounded() {
        let mut state = loop_state(0, None);
        for round in 0..100 {
            assert_eq!(
                advance(&mut state, &observe(&format!("轮 {round}"), true)),
                Decision::Continue
            );
        }
        assert_eq!(state.iteration, 100);
    }
}
