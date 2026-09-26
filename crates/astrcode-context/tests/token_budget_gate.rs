//! token_budget 与 compact 阈值集成冒烟。

use astrcode_context::{
    token_budget::{build_prompt_snapshot, compact_threshold_tokens, should_compact},
    token_estimate::estimate_char_budget,
};
use astrcode_core::llm::{LlmMessage, ModelLimits};

#[test]
fn compact_gate_triggers_at_configured_fraction() {
    let limits = ModelLimits {
        max_input_tokens: 10_000,
        max_output_tokens: 1_024,
    };
    let threshold = compact_threshold_tokens(limits.max_input_tokens, 80.0, None);
    let prompt = "x".repeat(estimate_char_budget(threshold));
    let messages = vec![LlmMessage::user(prompt)];
    let snapshot = build_prompt_snapshot(&messages, None, limits, 80.0, None);
    assert!(should_compact(snapshot));
    assert_eq!(snapshot.threshold_tokens, threshold);
}

#[test]
fn compact_gate_caps_threshold_for_large_windows() {
    let limits = ModelLimits {
        max_input_tokens: 1_000_000,
        max_output_tokens: 32_768,
    };
    let messages = vec![LlmMessage::user("x".repeat(estimate_char_budget(200_000)))];

    let capped = build_prompt_snapshot(&messages, None, limits.clone(), 83.5, Some(200_000));
    assert_eq!(capped.threshold_tokens, 200_000);
    assert!(should_compact(capped));

    let uncapped = build_prompt_snapshot(&messages, None, limits, 83.5, None);
    assert_eq!(uncapped.threshold_tokens, 835_000);
    assert!(!should_compact(uncapped));
}
