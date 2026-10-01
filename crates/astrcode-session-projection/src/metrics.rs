//! 会话模型用量与吞吐指标投影。

use astrcode_core::{event::DurableEventPayload, llm::LlmTokenUsage, types::TurnId};
use chrono::{DateTime, Utc};

/// 会话累计的模型用量与吞吐指标。
///
/// 这是读模型的派生视图，不是 wire DTO。`Inclusive` / `Components` 两种 input 计数
/// 语义先在 [`LlmTokenUsage::normalized_prompt_tokens`] 上归一化再累加，保证
/// `cached_tokens / prompt_tokens` 的分母口径与宿主 token 预算统计一致。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionMetrics {
    /// 上报过用量的模型请求数。
    pub requests: u64,
    /// 归一化后的完整 prompt token 数。
    pub prompt_tokens: u64,
    /// 其中命中缓存读取的 token 数。
    pub cached_tokens: u64,
    /// 写入缓存的 token 数（仅组成部分语义的 provider 会非零）。
    pub cache_creation_tokens: u64,
    /// 生成 token 数。
    pub output_tokens: u64,
    /// 其中推理 token 数。
    pub reasoning_output_tokens: u64,
    /// 最近一次响应结束后占用的上下文 token；上下文身份变化时清空。
    pub context_tokens: Option<usize>,
    /// 与 `context_tokens` 同一次上报的上下文窗口大小。
    pub model_context_window: Option<usize>,
    /// 当前轮的吞吐样本；尚未累计到任何计时样本时为 `None`。
    pub throughput: Option<TurnThroughput>,
    /// fold 中间状态：当前 step 的模型请求开始时间。
    request_started_at: Option<DateTime<Utc>>,
    /// fold 中间状态：`throughput` 正在累计的 turn，用于判断是否已进入新一轮。
    throughput_turn_id: Option<TurnId>,
}

/// 单轮模型请求的吞吐样本。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TurnThroughput {
    /// 本轮已生成的 token 数。
    pub output_tokens: u64,
    /// 本轮模型请求耗时（毫秒），不含工具执行与人工等待。
    pub request_millis: u64,
}

impl TurnThroughput {
    /// 每秒生成 token 数；没有计时样本时返回 `None`。
    pub fn output_tokens_per_second(&self) -> Option<f64> {
        (self.request_millis > 0)
            .then(|| self.output_tokens as f64 * 1000.0 / self.request_millis as f64)
    }
}

impl SessionMetrics {
    /// 是否已有可展示的用量。
    pub fn has_usage(&self) -> bool {
        self.requests > 0
    }

    /// 缓存命中率；没有 prompt 计数时返回 `None`（而不是 0，避免误导）。
    pub fn cache_hit_rate(&self) -> Option<f64> {
        (self.prompt_tokens > 0).then(|| self.cached_tokens as f64 / self.prompt_tokens as f64)
    }
    /// 把一条 durable 事实折叠进累计指标。
    ///
    /// 入参拆成字段而非 `&DurableEvent`：live 流的进程内 `Event` 与 `DurableEvent`
    /// 字段相同但不是同一类型，拆字段让两条路径共用同一套折叠规则。
    ///
    /// 返回对外可见的指标是否发生变化，供 live 流决定是否需要推送。
    pub fn record(
        &mut self,
        payload: &DurableEventPayload,
        turn_id: Option<&TurnId>,
        timestamp: DateTime<Utc>,
    ) -> bool {
        match payload {
            DurableEventPayload::StepStarted { .. } => {
                self.request_started_at = Some(timestamp);
                false
            },
            // 与 `SessionModelContext::usage` 同步清空：这些事件改变了 provider 视图的
            // 身份，旧的上下文占用不再是当前上下文的可靠读数。
            DurableEventPayload::ModelIdChanged { .. }
            | DurableEventPayload::SessionToolsConfigured { .. }
            | DurableEventPayload::SessionForked { .. }
            | DurableEventPayload::SystemPromptConfigured { .. }
            | DurableEventPayload::TranscriptRewritten { .. } => {
                self.context_tokens = None;
                self.model_context_window = None;
                false
            },
            DurableEventPayload::TokenUsageRecorded {
                usage,
                model_context_window,
            } => self.record_usage(usage, *model_context_window, turn_id, timestamp),
            _ => false,
        }
    }

    fn record_usage(
        &mut self,
        usage: &LlmTokenUsage,
        model_context_window: usize,
        turn_id: Option<&TurnId>,
        timestamp: DateTime<Utc>,
    ) -> bool {
        if !usage.has_any_usage() {
            return false;
        }
        let prompt = usage.normalized_prompt_tokens();
        self.requests = self.requests.saturating_add(1);
        self.prompt_tokens = self.prompt_tokens.saturating_add(prompt.full);
        self.cached_tokens = self.cached_tokens.saturating_add(prompt.cached);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(usage.cache_creation_input_tokens.unwrap_or_default());
        self.output_tokens = self
            .output_tokens
            .saturating_add(usage.output_tokens.unwrap_or_default());
        self.reasoning_output_tokens = self
            .reasoning_output_tokens
            .saturating_add(usage.reasoning_output_tokens.unwrap_or_default());
        if let Some(context_tokens) = usage
            .context_tokens_after_response()
            .and_then(|tokens| usize::try_from(tokens).ok())
        {
            self.context_tokens = Some(context_tokens);
            self.model_context_window = Some(model_context_window);
        }

        // 速度只统计模型请求时长：以最近一次 StepStarted 为锚点，工具执行与人工等待
        // 不计入。缺少锚点（历史日志、进程重启后的首个样本）时该样本只计 token 不计时。
        if self.throughput_turn_id.as_ref() != turn_id {
            self.throughput_turn_id = turn_id.cloned();
            self.throughput = Some(TurnThroughput::default());
        }
        let throughput = self.throughput.get_or_insert_with(TurnThroughput::default);
        throughput.output_tokens = throughput
            .output_tokens
            .saturating_add(usage.output_tokens.unwrap_or_default());
        if let Some(started_at) = self.request_started_at.take()
            && let Ok(millis) = u64::try_from(
                timestamp
                    .signed_duration_since(started_at)
                    .num_milliseconds(),
            )
        {
            throughput.request_millis = throughput.request_millis.saturating_add(millis);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use astrcode_core::{
        event::{DurableEvent, DurableEventPayload, StoredEvent},
        llm::{LlmInputTokenAccounting, LlmTokenUsage},
        types::{SessionId, TurnId},
    };

    use super::SessionMetrics;

    fn apply_event(event: &StoredEvent, metrics: &mut SessionMetrics) {
        metrics.record(&event.payload, event.turn_id.as_ref(), event.timestamp);
    }

    fn usage(input: u64, cached: u64, output: u64) -> LlmTokenUsage {
        LlmTokenUsage {
            input_tokens: Some(input),
            cached_input_tokens: Some(cached),
            output_tokens: Some(output),
            ..LlmTokenUsage::default()
        }
    }

    fn stored(seq: u64, turn_id: Option<TurnId>, payload: DurableEventPayload) -> StoredEvent {
        stored_at(seq, turn_id, payload, chrono::Utc::now())
    }

    fn stored_at(
        seq: u64,
        turn_id: Option<TurnId>,
        payload: DurableEventPayload,
        timestamp: chrono::DateTime<chrono::Utc>,
    ) -> StoredEvent {
        let mut event = DurableEvent::new(SessionId::new("session-metrics"), turn_id, payload);
        event.timestamp = timestamp;
        StoredEvent::new(seq, event)
    }

    #[test]
    fn cumulative_totals_normalize_each_sample_before_accumulating() {
        let mut metrics = SessionMetrics::default();
        let turn_id = TurnId::new("turn-1");

        // Inclusive：input 已含缓存读取。
        apply_event(
            &stored(
                1,
                Some(turn_id.clone()),
                DurableEventPayload::TokenUsageRecorded {
                    usage: usage(100, 80, 10),
                    model_context_window: 1_000_000,
                },
            ),
            &mut metrics,
        );
        // Components：三个分量独立。
        apply_event(
            &stored(
                2,
                Some(turn_id.clone()),
                DurableEventPayload::TokenUsageRecorded {
                    usage: LlmTokenUsage {
                        input_accounting: Some(LlmInputTokenAccounting::Components),
                        cache_creation_input_tokens: Some(10),
                        ..usage(20, 70, 5)
                    },
                    model_context_window: 1_000_000,
                },
            ),
            &mut metrics,
        );

        assert_eq!(metrics.requests, 2);
        assert_eq!(metrics.prompt_tokens, 200);
        assert_eq!(metrics.cached_tokens, 150);
        assert_eq!(metrics.output_tokens, 15);
        assert_eq!(metrics.cache_hit_rate(), Some(0.75));
        // 上下文读数是最近一次响应后的占用：input + 缓存读取 + 缓存写入 + output。
        assert_eq!(metrics.context_tokens, Some(105));
    }

    #[test]
    fn throughput_only_counts_model_request_time() {
        let mut metrics = SessionMetrics::default();
        let turn_id = TurnId::new("turn-1");
        let started_at = chrono::Utc::now();

        let step = stored_at(
            1,
            Some(turn_id.clone()),
            DurableEventPayload::StepStarted {
                step_index: 0,
                attempt: 0,
            },
            started_at,
        );
        apply_event(&step, &mut metrics);

        let usage_event = stored_at(
            2,
            Some(turn_id.clone()),
            DurableEventPayload::TokenUsageRecorded {
                usage: usage(10, 0, 500),
                model_context_window: 1_000_000,
            },
            started_at + chrono::Duration::milliseconds(2_000),
        );
        apply_event(&usage_event, &mut metrics);

        let throughput = metrics.throughput.expect("throughput sample");
        assert_eq!(throughput.output_tokens, 500);
        assert_eq!(throughput.request_millis, 2_000);
        assert_eq!(throughput.output_tokens_per_second(), Some(250.0));
    }

    #[test]
    fn a_new_turn_resets_the_throughput_sample() {
        let mut metrics = SessionMetrics::default();
        let first = TurnId::new("turn-1");
        let second = TurnId::new("turn-2");

        for (seq, turn_id) in [(1, first.clone()), (2, second.clone())] {
            let event = stored_at(
                seq,
                Some(turn_id),
                DurableEventPayload::TokenUsageRecorded {
                    usage: usage(10, 0, 100),
                    model_context_window: 1_000_000,
                },
                chrono::Utc::now(),
            );
            apply_event(&event, &mut metrics);
        }

        assert_eq!(metrics.requests, 2);
        assert_eq!(metrics.output_tokens, 200);
        assert_eq!(metrics.throughput.expect("throughput").output_tokens, 100);
    }

    #[test]
    fn context_reading_is_cleared_when_the_provider_view_identity_changes() {
        let mut metrics = SessionMetrics::default();
        apply_event(
            &stored(
                1,
                None,
                DurableEventPayload::TokenUsageRecorded {
                    usage: usage(10, 0, 10),
                    model_context_window: 1_000_000,
                },
            ),
            &mut metrics,
        );
        assert!(metrics.context_tokens.is_some());

        apply_event(
            &stored(
                2,
                None,
                DurableEventPayload::ModelIdChanged {
                    model_id: "model-b".into(),
                },
            ),
            &mut metrics,
        );
        assert!(metrics.context_tokens.is_none());
        // 累计用量不受上下文身份变化影响。
        assert_eq!(metrics.requests, 1);
        assert_eq!(metrics.prompt_tokens, 10);
    }
}
