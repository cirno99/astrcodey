//! 退化重复守卫：识别模型陷入「短时间内大量重复文字行」的死循环。
//!
//! 判定只看 assistant 正文的**完整行**，不看 thinking 与工具参数。窗口填满后才可能触发，
//! 且要求连续两个窗口都满足条件，避免边界抖动造成误杀。

use std::collections::{HashSet, VecDeque};

/// 参与判定的最近非空行数。
const WINDOW_LINES: usize = 40;
/// 窗口内允许的最大去重行数。
const MAX_DISTINCT_LINES: usize = 16;
/// 窗口内允许的平均行长（字符）。
const MAX_AVG_LINE_CHARS: usize = 32;
/// 触发前需要连续满足条件的窗口数。
const CONSECUTIVE_HITS_REQUIRED: u32 = 2;

/// 错误文本中的稳定前缀，供宿主之外的消费者（如看板扩展）识别这一类失败。
///
/// 看板扩展只能依赖插件系统，无法引用本常量，按字面量匹配并在注释里指向本文件。
pub const DEGENERATE_REPETITION_MARKER: &str = "degenerate repetition detected";

/// 一次退化重复的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DegenerateRepetition {
    pub distinct_lines: usize,
    pub window_lines: usize,
}

/// 增量文本的退化重复检测器。
#[derive(Debug, Default)]
pub(crate) struct RepetitionGuard {
    lines: VecDeque<String>,
    tail: String,
    consecutive_hits: u32,
}

impl RepetitionGuard {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 重试会重放同一段流，历史统计必须一并清空。
    pub(crate) fn reset(&mut self) {
        self.lines.clear();
        self.tail.clear();
        self.consecutive_hits = 0;
    }

    /// 喂入一段增量文本，返回 `Some` 表示检测到退化重复。
    pub(crate) fn observe(&mut self, delta: &str) -> Option<DegenerateRepetition> {
        self.tail.push_str(delta);
        while let Some(index) = self.tail.find('\n') {
            let line = self.tail[..index].trim().to_string();
            self.tail.drain(..=index);
            if line.is_empty() {
                continue;
            }
            self.lines.push_back(line);
            if self.lines.len() > WINDOW_LINES {
                self.lines.pop_front();
            }
        }
        self.evaluate()
    }

    fn evaluate(&mut self) -> Option<DegenerateRepetition> {
        if self.lines.len() < WINDOW_LINES {
            self.consecutive_hits = 0;
            return None;
        }

        let distinct: HashSet<&str> = self.lines.iter().map(String::as_str).collect();
        let total_chars: usize = self.lines.iter().map(|line| line.chars().count()).sum();
        let avg_chars = total_chars / self.lines.len();
        if distinct.len() > MAX_DISTINCT_LINES || avg_chars > MAX_AVG_LINE_CHARS {
            self.consecutive_hits = 0;
            return None;
        }

        self.consecutive_hits += 1;
        if self.consecutive_hits < CONSECUTIVE_HITS_REQUIRED {
            return None;
        }
        Some(DegenerateRepetition {
            distinct_lines: distinct.len(),
            window_lines: self.lines.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(guard: &mut RepetitionGuard, text: &str) -> Option<DegenerateRepetition> {
        guard.observe(text)
    }

    /// 用户实际遇到的循环：约十来个短句反复轮转。
    #[test]
    fn cycling_short_phrases_are_detected() {
        const PHRASES: [&str; 13] = [
            "Let me output.",
            "OK.",
            "Producing now.",
            "Let me write.",
            "I'll do it.",
            "Now.",
            "OK.",
            "Producing.",
            "Let me write the calls.",
            "OK, here.",
            "Writing.",
            "Let me produce.",
            "OK.",
        ];
        let mut guard = RepetitionGuard::new();
        let mut detected = None;
        for index in 0..80 {
            let line = format!("{}\n", PHRASES[index % PHRASES.len()]);
            if let Some(repetition) = feed(&mut guard, &line) {
                detected = Some(repetition);
                break;
            }
        }
        let repetition = detected.expect("循环短语必须被判定为退化重复");
        assert_eq!(repetition.window_lines, WINDOW_LINES);
        assert!(repetition.distinct_lines <= MAX_DISTINCT_LINES);
    }

    #[test]
    fn varied_prose_never_trips_the_guard() {
        let mut guard = RepetitionGuard::new();
        for index in 0..200 {
            let line = format!("这是第 {index} 段有实质内容的说明文字，长度和用词都在变化。\n");
            assert!(
                feed(&mut guard, &line).is_none(),
                "第 {index} 行不应触发退化重复"
            );
        }
    }

    #[test]
    fn long_lines_are_not_treated_as_degenerate() {
        let mut guard = RepetitionGuard::new();
        let line = format!("{}\n", "a".repeat(200));
        for _ in 0..80 {
            assert!(feed(&mut guard, &line).is_none());
        }
    }

    #[test]
    fn short_output_does_not_trip_the_guard() {
        let mut guard = RepetitionGuard::new();
        for _ in 0..10 {
            assert!(feed(&mut guard, "OK.\n").is_none());
        }
    }

    #[test]
    fn deltas_split_mid_line_are_joined_before_judging() {
        let mut guard = RepetitionGuard::new();
        let mut detected = None;
        for index in 0..80 {
            let phrase = if index % 2 == 0 { "OK." } else { "Producing." };
            if let Some(repetition) = feed(&mut guard, phrase) {
                detected = Some(repetition);
                break;
            }
            if let Some(repetition) = feed(&mut guard, "\n") {
                detected = Some(repetition);
                break;
            }
        }
        assert!(detected.is_some(), "跨增量的半行必须能拼回完整行");
    }

    /// 宿主之外的消费者（看板扩展）按字面量识别这类失败，前缀必须与错误文案一致。
    #[test]
    fn marker_matches_the_rendered_turn_error() {
        let error = crate::turn_context::TurnError::DegenerateRepetition {
            distinct_lines: 13,
            window_lines: WINDOW_LINES,
        };
        assert!(
            error.to_string().starts_with(DEGENERATE_REPETITION_MARKER),
            "错误文案必须以 {DEGENERATE_REPETITION_MARKER:?} 开头，实际为 {error}"
        );
    }

    #[test]
    fn reset_clears_history_so_a_retry_starts_fresh() {
        let mut guard = RepetitionGuard::new();
        for _ in 0..(WINDOW_LINES * 2) {
            feed(&mut guard, "OK.\n");
        }
        guard.reset();
        assert!(feed(&mut guard, "OK.\n").is_none());
    }
}
