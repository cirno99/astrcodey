//! SSE 行缓冲器与 UTF-8 流式解码器。
//!
//! 这两个组件是所有 HTTP 流式 LLM provider 的基础设施：
//! - [`SseLineReader`]：跨 TCP chunk 拼接完整的 SSE 行。
//! - [`Utf8StreamDecoder`]：跨 chunk 处理多字节 UTF-8 边界和坏字节。
//!
//! 两者在稳态下零分配：行缓冲用消费游标替代逐行 `drain`，产出的行以借用切片返回，
//! 解码输出写进跨调用复用的 `String`。

use std::ops::Range;

/// 流解码器内部缓冲上限（16 MiB）。
pub const MAX_STREAM_BUFFER_BYTES: usize = 16 * 1024 * 1024;

/// 行缓冲压缩阈值。
///
/// 逐行 `drain` 会让每条 SSE 行都触发一次 O(缓冲长度) 的尾部搬移；改用消费游标后，
/// 只有已消费前缀累积到该长度才搬移一次。
const LINE_BUFFER_COMPACT_BYTES: usize = 8 * 1024;

/// 流解码器错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDecoderError {
    BufferOverflow,
}

impl std::fmt::Display for StreamDecoderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BufferOverflow => {
                write!(
                    f,
                    "stream buffer exceeded limit ({MAX_STREAM_BUFFER_BYTES} bytes)"
                )
            },
        }
    }
}

impl std::error::Error for StreamDecoderError {}

// ─── SseLineReader ───────────────────────────────────────────────────────

/// SSE 行缓冲器。
///
/// TCP 是字节流协议，一个完整的 SSE 行可能被分成多个 chunk。
/// 本结构在内部拼接不完整的行，每遇到换行符时产出一条完整行。
pub struct SseLineReader {
    buffer: String,
    /// `buffer[..consumed]` 已经产出，等待压缩回收。
    consumed: usize,
    /// 本次 `push_chunk` 产出的行区间（相对 `buffer` 的字节偏移），跨调用复用容量。
    line_ranges: Vec<Range<usize>>,
}

/// 一次 `push_chunk` 产出的完整行，借用自 [`SseLineReader`] 的内部缓冲。
pub struct Lines<'a> {
    reader: &'a SseLineReader,
    index: usize,
}

impl<'a> Iterator for Lines<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        let range = self.reader.line_ranges.get(self.index)?;
        self.index += 1;
        Some(&self.reader.buffer[range.clone()])
    }
}

impl SseLineReader {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
            consumed: 0,
            line_ranges: Vec::new(),
        }
    }

    /// 追加一个文本 chunk，返回本次产出的完整行（借用自内部缓冲）。
    pub fn push_chunk(&mut self, text: &str) -> Result<Lines<'_>, StreamDecoderError> {
        let pending = self.buffer.len() - self.consumed;
        if pending.saturating_add(text.len()) > MAX_STREAM_BUFFER_BYTES {
            return Err(StreamDecoderError::BufferOverflow);
        }
        if self.consumed >= LINE_BUFFER_COMPACT_BYTES {
            self.buffer.drain(..self.consumed);
            self.consumed = 0;
        }
        self.buffer.push_str(text);

        self.line_ranges.clear();
        let mut line_start = self.consumed;
        while let Some(offset) = self.buffer[line_start..].find('\n') {
            let line_end = line_start + offset;
            let line = self.buffer[line_start..line_end].trim_end_matches('\r');
            self.line_ranges.push(line_start..line_start + line.len());
            line_start = line_end + 1;
        }
        self.consumed = line_start;

        Ok(Lines {
            reader: self,
            index: 0,
        })
    }

    /// 流结束后刷新缓冲区，返回残留的最后一行（如果有）。
    ///
    /// 每个流只调用一次，这里的 `to_owned` 不在稳态路径上。
    pub fn flush(&mut self) -> Option<String> {
        let trimmed = self.buffer[self.consumed..].trim();
        let result = (!trimmed.is_empty()).then(|| trimmed.to_owned());
        self.buffer.clear();
        self.consumed = 0;
        self.line_ranges.clear();
        result
    }
}

impl Default for SseLineReader {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Utf8StreamDecoder ──────────────────────────────────────────────────

/// 流式 UTF-8 解码器，处理分块字节流中的多字节字符边界和坏字节。
///
/// - `push()` 追加新字节块并返回已确认完整的 UTF-8 文本
/// - `finish()` 在流结束时刷新尾部缓冲，对坏字节做容错恢复（替换为 U+FFFD）
///
/// 返回的文本借用自内部的 `decoded` 缓冲，该缓冲跨调用保留容量，因此稳态不分配。
pub struct Utf8StreamDecoder {
    pending: Vec<u8>,
    decoded: String,
}

/// 一次 UTF-8 扫描的结论。
enum DecodeStep {
    /// 整个缓冲都是合法 UTF-8。
    Complete,
    /// 前 `valid_up_to` 字节合法，其后是 `invalid_len` 字节的非法序列。
    Recovered {
        valid_up_to: usize,
        invalid_len: usize,
    },
    /// 前 `valid_up_to` 字节合法，其后是不完整的多字节序列。
    Incomplete { valid_up_to: usize },
}

fn scan_utf8(bytes: &[u8]) -> DecodeStep {
    match std::str::from_utf8(bytes) {
        Ok(_) => DecodeStep::Complete,
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            match error.error_len() {
                Some(invalid_len) => DecodeStep::Recovered {
                    valid_up_to,
                    invalid_len,
                },
                None => DecodeStep::Incomplete { valid_up_to },
            }
        },
    }
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            decoded: String::new(),
        }
    }

    /// 追加一个新的字节块，并返回当前已经确认完整的 UTF-8 文本。
    pub fn push(&mut self, chunk: &[u8]) -> Result<Option<&str>, StreamDecoderError> {
        if chunk.is_empty() {
            return Ok(None);
        }
        if self.pending.len().saturating_add(chunk.len()) > MAX_STREAM_BUFFER_BYTES {
            return Err(StreamDecoderError::BufferOverflow);
        }
        self.pending.extend_from_slice(chunk);
        self.decode_into_scratch(false);
        Ok(self.decoded_text())
    }

    /// 在流结束时刷新尾部缓冲。
    ///
    /// 如果尾部是损坏/不完整 UTF-8，替换为 U+FFFD 并继续。
    pub fn finish(&mut self) -> Option<&str> {
        if self.pending.is_empty() {
            return None;
        }
        self.decode_into_scratch(true);
        self.decoded_text()
    }

    fn decoded_text(&self) -> Option<&str> {
        if self.decoded.is_empty() {
            None
        } else {
            Some(self.decoded.as_str())
        }
    }

    /// 把 `pending` 中可确认的字节解码进复用的 `decoded` 缓冲。
    ///
    /// `final_flush` 为 `true` 时把不完整尾序列按 U+FFFD 处理（流结束），
    /// 为 `false` 时保留尾部等待后续 chunk。
    fn decode_into_scratch(&mut self, final_flush: bool) {
        self.decoded.clear();

        loop {
            match scan_utf8(&self.pending) {
                DecodeStep::Complete => {
                    self.decoded.push_str(valid_utf8_prefix(&self.pending));
                    self.pending.clear();
                    return;
                },
                DecodeStep::Recovered {
                    valid_up_to,
                    invalid_len,
                } => {
                    self.push_valid_prefix(valid_up_to);
                    if final_flush {
                        tracing::warn!(
                            "stream decoder recovered invalid utf-8 sequence at stream end: \
                             valid_up_to={valid_up_to}, invalid_len={invalid_len}, bytes={}",
                            debug_utf8_bytes(&self.pending, valid_up_to, Some(invalid_len))
                        );
                    } else {
                        tracing::warn!(
                            "stream decoder recovered invalid utf-8 sequence: valid_up_to={}, \
                             invalid_len={}, bytes={}",
                            valid_up_to,
                            invalid_len,
                            debug_utf8_bytes(&self.pending, valid_up_to, Some(invalid_len))
                        );
                    }
                    self.decoded.push(char::REPLACEMENT_CHARACTER);
                    self.pending.drain(..valid_up_to + invalid_len);
                    if self.pending.is_empty() {
                        return;
                    }
                },
                DecodeStep::Incomplete { valid_up_to } => {
                    self.push_valid_prefix(valid_up_to);
                    if final_flush {
                        tracing::warn!(
                            "stream decoder recovered incomplete utf-8 tail at stream end: \
                             valid_up_to={valid_up_to}, bytes={}",
                            debug_utf8_bytes(&self.pending, valid_up_to, None)
                        );
                        self.decoded.push(char::REPLACEMENT_CHARACTER);
                        self.pending.clear();
                    } else {
                        self.pending.drain(..valid_up_to);
                    }
                    return;
                },
            }
        }
    }

    fn push_valid_prefix(&mut self, valid_up_to: usize) {
        if valid_up_to > 0 {
            self.decoded
                .push_str(valid_utf8_prefix(&self.pending[..valid_up_to]));
        }
    }
}

impl Default for Utf8StreamDecoder {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

fn valid_utf8_prefix(bytes: &[u8]) -> &str {
    match std::str::from_utf8(bytes) {
        Ok(prefix) => prefix,
        Err(error) => {
            tracing::error!(%error, "Utf8Error::valid_up_to returned an invalid prefix");
            ""
        },
    }
}

/// 格式化 UTF-8 字节片段用于日志输出。
fn debug_utf8_bytes(bytes: &[u8], valid_up_to: usize, invalid_len: Option<usize>) -> String {
    let start = valid_up_to.saturating_sub(8);
    let end = invalid_len
        .map(|len| (valid_up_to + len + 8).min(bytes.len()))
        .unwrap_or(bytes.len().min(valid_up_to + 8));

    bytes[start..end]
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if start + i == valid_up_to {
                format!("[{b:02x}")
            } else if invalid_len.is_some_and(|len| start + i == valid_up_to + len - 1) {
                format!("{b:02x}]")
            } else {
                format!("{b:02x}")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 清理 JSON 片段，去除控制字符但保留所有可打印字符（包括 Unicode）。
pub(crate) fn clean_json_fragment(fragment: &str) -> String {
    // 工具参数增量几乎总是干净文本（刚从 JSON 字符串解码），仅少数兼容厂商夹带控制字符。
    // 无控制字符时直接拷贝，避免逐字符 filter + collect 的二次分配。
    if !fragment
        .chars()
        .any(|c| c.is_control() && !c.is_whitespace())
    {
        return fragment.to_owned();
    }
    fragment
        .chars()
        .filter(|&c| !c.is_control() || c.is_whitespace())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_line_reader_splits_on_newline() {
        let mut reader = SseLineReader::new();
        let lines = reader.push_chunk("data: hello\ndata: world\n").unwrap();
        assert_eq!(
            lines.collect::<Vec<_>>(),
            vec!["data: hello", "data: world"]
        );
    }

    #[test]
    fn sse_line_reader_buffers_partial_line() {
        let mut reader = SseLineReader::new();
        let lines = reader.push_chunk("data: hel").unwrap();
        assert_eq!(lines.count(), 0);
        let lines = reader.push_chunk("lo\n").unwrap();
        assert_eq!(lines.collect::<Vec<_>>(), vec!["data: hello"]);
    }

    #[test]
    fn sse_line_reader_flush_returns_remaining() {
        let mut reader = SseLineReader::new();
        reader.push_chunk("data: last").unwrap();
        assert_eq!(reader.flush(), Some("data: last".to_string()));
    }

    #[test]
    fn sse_line_reader_flush_returns_none_when_empty() {
        let mut reader = SseLineReader::new();
        reader.push_chunk("data: done\n").unwrap();
        assert_eq!(reader.flush(), None);
    }

    #[test]
    fn sse_line_reader_handles_crlf() {
        let mut reader = SseLineReader::new();
        let lines = reader.push_chunk("data: hello\r\ndata: world\r\n").unwrap();
        assert_eq!(
            lines.collect::<Vec<_>>(),
            vec!["data: hello", "data: world"]
        );
    }

    #[test]
    fn utf8_decoder_handles_multibyte_boundary() {
        let mut decoder = Utf8StreamDecoder::new();
        // "你好" = e4 bd a0 e5 a5 bd
        let first = decoder.push(&[0xe4, 0xbd]).unwrap();
        assert!(first.is_none());
        let second = decoder.push(&[0xa0, 0xe5, 0xa5, 0xbd]).unwrap();
        assert_eq!(second, Some("你好"));
    }

    #[test]
    fn utf8_decoder_finish_replaces_incomplete_tail() {
        let mut decoder = Utf8StreamDecoder::new();
        decoder.push(&[0xe4, 0xbd]).unwrap();
        let result = decoder.finish();
        assert!(result.is_some());
        assert!(result.unwrap().contains('\u{FFFD}'));
    }

    #[test]
    fn sse_line_reader_rejects_oversized_buffer() {
        let mut reader = SseLineReader::new();
        let chunk = "x".repeat(MAX_STREAM_BUFFER_BYTES + 1);
        assert!(matches!(
            reader.push_chunk(&chunk),
            Err(StreamDecoderError::BufferOverflow)
        ));
    }

    #[test]
    fn utf8_decoder_rejects_oversized_buffer() {
        let mut decoder = Utf8StreamDecoder::new();
        let chunk = vec![0x41; MAX_STREAM_BUFFER_BYTES + 1];
        assert_eq!(
            decoder.push(&chunk),
            Err(StreamDecoderError::BufferOverflow)
        );
    }
    /// 稳态流解码必须零分配：解码输出写进复用的 `String`，行区间复用 `Vec` 容量，
    /// 产出的行以借用切片返回。
    ///
    /// 行缓冲的高水位由 `LINE_BUFFER_COMPACT_BYTES` 加上单次 push 的最大字节数界定，
    /// 因此工作集取到能触发多轮压缩的长度即可覆盖稳态。
    #[test]
    fn stream_decoding_steady_state_allocates_nothing() {
        fn consume(decoder: &mut Utf8StreamDecoder, reader: &mut SseLineReader, chunk: &str) {
            if let Some(text) = decoder.push(chunk.as_bytes()).unwrap() {
                for line in reader.push_chunk(text).unwrap() {
                    std::hint::black_box(line);
                }
            }
        }

        let chunks: Vec<String> = (0..2048)
            .map(|index| format!("data: {{\"n\":{index}}}\n\n"))
            .collect();
        let mut decoder = Utf8StreamDecoder::new();
        let mut reader = SseLineReader::new();

        // 预热：把 pending / decoded / buffer / line_ranges 抬到稳态高水位。
        for chunk in &chunks {
            consume(&mut decoder, &mut reader, chunk);
        }

        let allocations = crate::alloc_probe::count_allocations(|| {
            for chunk in &chunks {
                consume(&mut decoder, &mut reader, chunk);
            }
        });

        assert_eq!(
            allocations, 0,
            "稳态流解码不应分配：解码输出与行区间都必须复用既有缓冲"
        );
    }
}
