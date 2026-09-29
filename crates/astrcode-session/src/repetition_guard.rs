//! 退化重复守卫：识别模型陷入「短时间内大量重复文字」的死循环。
//!
//! 判定把流式文本切成**片段**（换行与句末标点都是边界），只看 assistant 正文与思考，
//! 不看工具参数。窗口填满后才可能触发，且要求连续两个窗口都满足条件，避免边界抖动造成误杀。
//!
//! 开销约束（流式热路径，每个增量都会走一遍）：
//!
//! - 增量只扫描新增字节：扫描游标随文本推进，不回退重扫。
//! - 窗口统计是增量的：去重数与总长度在入窗 / 出窗时维护，判定本身是 O(1)。
//! - 单片段长度有上限：超过 [`MAX_PENDING_BYTES`] 未出现边界即判定为长文输出并重置统计，
//!   内存与单次扫描量都不随输出长度增长。

use std::{
    collections::{HashMap, VecDeque, hash_map::Entry},
    sync::Arc,
};

/// 参与判定的最近片段数。
const WINDOW_FRAGMENTS: usize = 40;
/// 窗口内允许的最大去重片段数。
const MAX_DISTINCT_FRAGMENTS: usize = 16;
/// 窗口内允许的平均片段长度（字符）。
const MAX_AVG_FRAGMENT_CHARS: usize = 32;
/// 触发前需要连续满足条件的窗口数。
const CONSECUTIVE_HITS_REQUIRED: u32 = 2;
/// 未出现边界时最多保留的字节数。
const MAX_PENDING_BYTES: usize = 64 * 1024;

/// 错误文本中的稳定前缀，供宿主之外的消费者（如看板扩展）识别这一类失败。
///
/// 看板扩展只能依赖插件系统，无法引用本常量，按字面量匹配并在注释里指向本文件。
pub const DEGENERATE_REPETITION_MARKER: &str = "degenerate repetition detected";

/// 产生退化重复的文本通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepetitionStream {
    /// assistant 正文。
    Text,
    /// assistant 思考（reasoning）：模型的自我复读多数发生在这里。
    Thinking,
}

impl std::fmt::Display for RepetitionStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text => f.write_str("正文"),
            Self::Thinking => f.write_str("思考"),
        }
    }
}

/// 一次退化重复的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DegenerateRepetition {
    pub stream: RepetitionStream,
    pub distinct_fragments: usize,
    pub window_fragments: usize,
}

/// 单条文本通道的退化重复检测器。
#[derive(Debug)]
pub(crate) struct RepetitionGuard {
    stream: RepetitionStream,
    /// 滑动窗口内的片段，按进入顺序排列。
    window: VecDeque<Fragment>,
    /// 窗口内每个片段的出现次数，`len()` 即去重片段数。
    counts: HashMap<Arc<str>, u32>,
    /// 窗口内片段的字符总数。
    total_chars: usize,
    /// 尚未遇到边界的尾部文本。
    pending: String,
    /// `pending` 中已扫描到的字节位置。
    scanned: usize,
    consecutive_hits: u32,
}

#[derive(Debug)]
struct Fragment {
    text: Arc<str>,
    chars: usize,
}

impl RepetitionGuard {
    pub(crate) fn new(stream: RepetitionStream) -> Self {
        Self {
            stream,
            window: VecDeque::new(),
            counts: HashMap::new(),
            total_chars: 0,
            pending: String::new(),
            scanned: 0,
            consecutive_hits: 0,
        }
    }

    /// 重试会重放同一段流，历史统计必须一并清空。
    pub(crate) fn reset(&mut self) {
        self.clear_window();
        self.pending.clear();
        self.scanned = 0;
    }

    /// 喂入一段增量文本，返回 `Some` 表示检测到退化重复。
    pub(crate) fn observe(&mut self, delta: &str) -> Option<DegenerateRepetition> {
        self.pending.push_str(delta);
        if self.pending.len() > MAX_PENDING_BYTES {
            // 单个片段就超过上限，说明是长文输出而不是退化重复；统计从头开始。
            self.reset();
            return None;
        }

        let mut fragment_start = 0;
        while let Some(end) = next_boundary(&self.pending, &mut self.scanned) {
            let text = self.pending[fragment_start..end].trim();
            if !text.is_empty() {
                push_fragment(
                    &mut self.window,
                    &mut self.counts,
                    &mut self.total_chars,
                    text,
                );
            }
            fragment_start = end;
        }
        if fragment_start > 0 {
            self.pending.drain(..fragment_start);
            self.scanned -= fragment_start;
        }
        self.evaluate()
    }

    fn evaluate(&mut self) -> Option<DegenerateRepetition> {
        if self.window.len() < WINDOW_FRAGMENTS {
            self.consecutive_hits = 0;
            return None;
        }

        let avg_chars = self.total_chars / self.window.len();
        if self.counts.len() > MAX_DISTINCT_FRAGMENTS || avg_chars > MAX_AVG_FRAGMENT_CHARS {
            self.consecutive_hits = 0;
            return None;
        }

        self.consecutive_hits += 1;
        if self.consecutive_hits < CONSECUTIVE_HITS_REQUIRED {
            return None;
        }
        Some(DegenerateRepetition {
            stream: self.stream,
            distinct_fragments: self.counts.len(),
            window_fragments: self.window.len(),
        })
    }

    fn clear_window(&mut self) {
        self.window.clear();
        self.counts.clear();
        self.total_chars = 0;
        self.consecutive_hits = 0;
    }
}

/// 入窗：维护去重计数与字符总数，超出窗口容量时同步淘汰最旧的片段。
fn push_fragment(
    window: &mut VecDeque<Fragment>,
    counts: &mut HashMap<Arc<str>, u32>,
    total_chars: &mut usize,
    text: &str,
) {
    let chars = text.chars().count();
    let text: Arc<str> = Arc::from(text);
    *counts.entry(Arc::clone(&text)).or_insert(0) += 1;
    *total_chars += chars;
    window.push_back(Fragment { text, chars });

    if window.len() <= WINDOW_FRAGMENTS {
        return;
    }
    let Some(evicted) = window.pop_front() else {
        return;
    };
    if let Entry::Occupied(mut entry) = counts.entry(Arc::clone(&evicted.text)) {
        if *entry.get() > 1 {
            *entry.get_mut() -= 1;
        } else {
            entry.remove();
        }
    }
    *total_chars -= evicted.chars;
}

/// 从 `cursor` 开始找下一个已确定的片段边界，并把 `cursor` 推进到扫描停止处。
///
/// 换行与中文句末标点总是边界；`.` / `!` / `?` 只在后接空白时才算句末，避免把
/// `foo.bar()`、`3.14`、`file.rs` 切碎。句末标点后面还没收到字符时游标停在标点处，
/// 等下一个增量再判定，因此已扫描的文本不会被重复扫描。
fn next_boundary(text: &str, cursor: &mut usize) -> Option<usize> {
    for (offset, ch) in text[*cursor..].char_indices() {
        let index = *cursor + offset;
        let end = index + ch.len_utf8();
        match ch {
            '\n' | '。' | '！' | '？' | '；' | ';' => {
                *cursor = end;
                return Some(end);
            },
            '.' | '!' | '?' => {
                if text[end..].chars().next().is_some_and(char::is_whitespace) {
                    *cursor = end;
                    return Some(end);
                }
                if end == text.len() {
                    *cursor = index;
                    return None;
                }
            },
            _ => {},
        }
    }
    *cursor = text.len();
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard(stream: RepetitionStream) -> RepetitionGuard {
        RepetitionGuard::new(stream)
    }

    fn feed(guard: &mut RepetitionGuard, text: &str) -> Option<DegenerateRepetition> {
        guard.observe(text)
    }

    fn boundary_of(text: &str) -> Option<usize> {
        let mut cursor = 0;
        next_boundary(text, &mut cursor)
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
        let mut guard = guard(RepetitionStream::Text);
        let mut detected = None;
        for index in 0..80 {
            let line = format!("{}\n", PHRASES[index % PHRASES.len()]);
            if let Some(repetition) = feed(&mut guard, &line) {
                detected = Some(repetition);
                break;
            }
        }
        let repetition = detected.expect("循环短语必须被判定为退化重复");
        assert_eq!(repetition.stream, RepetitionStream::Text);
        assert_eq!(repetition.window_fragments, WINDOW_FRAGMENTS);
        assert!(repetition.distinct_fragments <= MAX_DISTINCT_FRAGMENTS);
    }

    /// 思考里的复读往往没有换行，只有句末标点。
    #[test]
    fn run_on_thinking_repetition_is_detected() {
        let mut guard = guard(RepetitionStream::Thinking);
        let mut detected = None;
        for _ in 0..80 {
            if let Some(repetition) = feed(&mut guard, "Let me check. Wait, let me reconsider. ") {
                detected = Some(repetition);
                break;
            }
        }
        let repetition = detected.expect("无换行的思考复读必须被判定为退化重复");
        assert_eq!(repetition.stream, RepetitionStream::Thinking);
    }

    #[test]
    fn varied_prose_never_trips_the_guard() {
        let mut guard = guard(RepetitionStream::Text);
        for index in 0..200 {
            let line = format!("这是第 {index} 段有实质内容的说明文字，长度和用词都在变化。\n");
            assert!(
                feed(&mut guard, &line).is_none(),
                "第 {index} 行不应触发退化重复"
            );
        }
    }

    #[test]
    fn long_fragments_are_not_treated_as_degenerate() {
        let mut guard = guard(RepetitionStream::Text);
        let line = format!("{}\n", "a".repeat(200));
        for _ in 0..80 {
            assert!(feed(&mut guard, &line).is_none());
        }
    }

    #[test]
    fn short_output_does_not_trip_the_guard() {
        let mut guard = guard(RepetitionStream::Text);
        for _ in 0..10 {
            assert!(feed(&mut guard, "OK.\n").is_none());
        }
    }

    #[test]
    fn deltas_split_mid_fragment_are_joined_before_judging() {
        let mut guard = guard(RepetitionStream::Text);
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
        assert!(detected.is_some(), "跨增量的半行必须能拼回完整片段");
    }

    /// 代码里的 `foo.bar()`、`3.14` 不能被当成句末。
    #[test]
    fn dots_inside_code_do_not_end_a_fragment() {
        assert_eq!(boundary_of("self.foo.bar()"), None);
        assert_eq!(boundary_of("let x = 3.14;"), Some(13));
        assert_eq!(boundary_of("done. Next"), Some(5));
    }

    /// 句末标点后还没收到字符时，游标停在标点处，不重扫已扫描的文本。
    #[test]
    fn a_trailing_period_waits_for_the_next_delta() {
        let mut cursor = 0;
        assert_eq!(next_boundary("done.", &mut cursor), None);
        assert_eq!(cursor, 4);

        let mut pending = String::from("done.");
        pending.push_str(" Next");
        assert_eq!(next_boundary(&pending, &mut cursor), Some(5));
    }

    /// 单行超长（无边界）时必须线性处理：扫描游标回退会退化成 O(n²)。
    #[test]
    fn a_very_long_line_is_processed_in_linear_time() {
        let mut guard = guard(RepetitionStream::Text);
        for _ in 0..100_000 {
            assert!(feed(&mut guard, "x").is_none());
        }
        // 超长行之后仍能正常识别循环。
        let mut detected = None;
        for _ in 0..80 {
            if let Some(repetition) = feed(&mut guard, "OK.\n") {
                detected = Some(repetition);
                break;
            }
        }
        assert!(detected.is_some(), "重置后必须仍能识别循环");
    }

    /// 宿主之外的消费者（看板扩展）按字面量识别这类失败，前缀必须与错误文案一致。
    #[test]
    fn marker_matches_the_rendered_turn_error() {
        let error = crate::turn_context::TurnError::DegenerateRepetition {
            stream: RepetitionStream::Thinking,
            distinct_fragments: 13,
            window_fragments: WINDOW_FRAGMENTS,
        };
        assert!(
            error.to_string().starts_with(DEGENERATE_REPETITION_MARKER),
            "错误文案必须以 {DEGENERATE_REPETITION_MARKER:?} 开头，实际为 {error}"
        );
        assert!(
            error.to_string().contains("思考"),
            "文案必须标明通道: {error}"
        );
    }

    #[test]
    fn reset_clears_history_so_a_retry_starts_fresh() {
        let mut guard = guard(RepetitionStream::Text);
        for _ in 0..(WINDOW_FRAGMENTS * 2) {
            feed(&mut guard, "OK.\n");
        }
        guard.reset();
        assert!(feed(&mut guard, "OK.\n").is_none());
    }
}
