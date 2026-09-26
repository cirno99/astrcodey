//! Event mapping: astrcode `EventPayload` → ACP `SessionUpdate`.

use agent_client_protocol::schema::{
    ContentBlock, ContentChunk, SessionNotification, SessionUpdate, TextContent, ToolCall,
    ToolCallContent, ToolCallId, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields,
};
use astrcode_core::event::{DurableEventPayload, EventPayload, LiveEventPayload, ToolOutputStream};

/// Convert an astrcode `EventPayload` into an ACP `SessionNotification`
/// for the given session. Returns `None` if the event has no ACP equivalent.
pub(super) fn to_session_notification(
    session_id: &str,
    payload: &EventPayload,
) -> Option<SessionNotification> {
    let update = to_session_update(payload)?;
    Some(SessionNotification::new(session_id.to_string(), update))
}

/// 将持久化历史事件映射为 ACP `SessionNotification`，用于 `session/load` 回放。
///
/// 与实时路径分开：实时路径已经用 live delta 转发助手文本，若在 durable 映射里
/// 补齐整条消息，同一段文本会在一次 turn 中重复出现。
pub(super) fn to_history_notification(
    session_id: &str,
    payload: &DurableEventPayload,
) -> Option<SessionNotification> {
    let update = match payload {
        DurableEventPayload::UserMessage { text, .. } => user_chunk(text.clone()),
        DurableEventPayload::AssistantMessageCompleted { text, .. } => text_chunk(text.clone()),
        payload => durable_session_update(payload)?,
    };
    Some(SessionNotification::new(session_id.to_string(), update))
}

fn text_chunk(delta: String) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
        delta,
    ))))
}

fn thought_chunk(delta: String) -> SessionUpdate {
    SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
        delta,
    ))))
}

fn user_chunk(text: String) -> SessionUpdate {
    SessionUpdate::UserMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new(
        text,
    ))))
}

fn to_session_update(payload: &EventPayload) -> Option<SessionUpdate> {
    match payload {
        EventPayload::Durable(payload) => durable_session_update(payload),
        EventPayload::Live(payload) => live_session_update(payload),
    }
}

fn durable_session_update(payload: &DurableEventPayload) -> Option<SessionUpdate> {
    match payload {
        DurableEventPayload::ToolCallRequested {
            call_id,
            tool_name,
            arguments,
            ..
        } => Some(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            ToolCallId::new(call_id.as_str()),
            ToolCallUpdateFields::new()
                .title(Some(tool_name.clone()))
                .status(Some(ToolCallStatus::InProgress))
                .raw_input(Some(arguments.clone())),
        ))),

        DurableEventPayload::ToolCallCompleted {
            call_id, result, ..
        } => Some(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            ToolCallId::new(call_id.as_str()),
            completed_tool_fields(
                ToolCallStatus::Completed,
                serde_json::json!({
                    "content": result.content,
                    "is_error": result.is_error,
                    "error": result.error,
                    "metadata": result.metadata,
                    "duration_ms": result.duration_ms,
                }),
            ),
        ))),

        DurableEventPayload::ToolCallFailed {
            call_id,
            error,
            metadata,
            duration_ms,
            ..
        } => Some(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            ToolCallId::new(call_id.as_str()),
            completed_tool_fields(
                ToolCallStatus::Failed,
                serde_json::json!({
                    "error": error,
                    "metadata": metadata,
                    "duration_ms": duration_ms,
                }),
            ),
        ))),

        DurableEventPayload::ToolCallCancelled {
            call_id,
            reason,
            duration_ms,
            ..
        } => Some(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            ToolCallId::new(call_id.as_str()),
            completed_tool_fields(
                ToolCallStatus::Failed,
                serde_json::json!({
                    ACP_TOOL_CALL_CANCELLED_MARKER: true,
                    "reason": reason,
                    "duration_ms": duration_ms,
                }),
            ),
        ))),

        DurableEventPayload::ErrorOccurred { message, .. } => {
            Some(text_chunk(format!("[Error] {message}")))
        },

        _ => None,
    }
}

fn live_session_update(payload: &LiveEventPayload) -> Option<SessionUpdate> {
    match payload {
        LiveEventPayload::AssistantTextDelta { delta, .. } => Some(text_chunk(delta.clone())),

        LiveEventPayload::ThinkingDelta { delta, .. } => Some(thought_chunk(delta.clone())),

        LiveEventPayload::ToolCallStarted { call_id, tool_name } => Some(SessionUpdate::ToolCall(
            ToolCall::new(ToolCallId::new(call_id.as_str()), tool_name.clone())
                .status(ToolCallStatus::InProgress),
        )),

        LiveEventPayload::ToolOutputDelta {
            call_id,
            stream,
            delta,
        } => Some(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            ToolCallId::new(call_id.as_str()),
            ToolCallUpdateFields::new()
                .status(Some(ToolCallStatus::InProgress))
                .content(Some(vec![ToolCallContent::from(format!(
                    "{}: {delta}",
                    stream_name(*stream)
                ))]))
                .raw_output(Some(serde_json::json!({
                    "stream": stream_name(*stream),
                    "delta": delta,
                }))),
        ))),

        LiveEventPayload::ErrorOccurred { message, .. } => {
            Some(text_chunk(format!("[Error] {message}")))
        },

        // Events that don't have a direct ACP equivalent are silently ignored.
        _ => None,
    }
}

/// ACP schema 的 `ToolCallStatus` 没有 Cancelled；取消以 `Failed` + raw_output
/// 中的此标记表达（生命周期之外的结果语义字段不受影响）。
const ACP_TOOL_CALL_CANCELLED_MARKER: &str = "cancelled";

fn completed_tool_fields(
    status: ToolCallStatus,
    raw_output: serde_json::Value,
) -> ToolCallUpdateFields {
    ToolCallUpdateFields::new()
        .status(Some(status))
        .raw_output(Some(raw_output))
}

fn stream_name(stream: ToolOutputStream) -> &'static str {
    match stream {
        ToolOutputStream::Stdout => "stdout",
        ToolOutputStream::Stderr => "stderr",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use astrcode_core::{
        event::{EventPayload, ToolOutputStream},
        tool::ToolResult,
        types::ToolCallId as CoreToolCallId,
    };

    use super::*;

    #[test]
    fn maps_tool_output_delta_to_tool_update() {
        let update = to_session_update(&EventPayload::Live(LiveEventPayload::ToolOutputDelta {
            call_id: CoreToolCallId::from("call-1"),
            stream: ToolOutputStream::Stdout,
            delta: "hello".into(),
        }))
        .unwrap();

        let SessionUpdate::ToolCallUpdate(update) = update else {
            panic!("expected tool call update");
        };

        assert_eq!(update.tool_call_id, ToolCallId::new("call-1"));
        assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        assert!(update.fields.raw_output.is_some());
    }

    #[test]
    fn maps_tool_terminal_events_to_lifecycle_statuses() {
        let cases = [
            (
                DurableEventPayload::ToolCallCompleted {
                    call_id: "call-ok".into(),
                    tool_name: "probe".into(),
                    result: ToolResult::success("done"),
                    arguments: String::new(),
                    arguments_json: None,
                },
                ToolCallStatus::Completed,
                false,
            ),
            // `is_error` 是结果语义，不影响生命周期状态。
            (
                DurableEventPayload::ToolCallCompleted {
                    call_id: "call-domain-error".into(),
                    tool_name: "probe".into(),
                    result: ToolResult::error("domain error"),
                    arguments: String::new(),
                    arguments_json: None,
                },
                ToolCallStatus::Completed,
                false,
            ),
            (
                DurableEventPayload::ToolCallFailed {
                    call_id: "call-failed".into(),
                    tool_name: "probe".into(),
                    error: "executor failed".into(),
                    metadata: BTreeMap::new(),
                    duration_ms: Some(7),
                    arguments: String::new(),
                    arguments_json: None,
                },
                ToolCallStatus::Failed,
                false,
            ),
            // ACP schema 无 Cancelled：取消以 Failed + raw_output 标记表达。
            (
                DurableEventPayload::ToolCallCancelled {
                    call_id: "call-cancelled".into(),
                    tool_name: "probe".into(),
                    reason: "turn aborted".into(),
                    duration_ms: Some(8),
                    arguments: String::new(),
                    arguments_json: None,
                },
                ToolCallStatus::Failed,
                true,
            ),
        ];

        for (payload, expected_status, expected_cancelled_marker) in cases {
            let update = to_session_update(&EventPayload::Durable(payload)).unwrap();
            let SessionUpdate::ToolCallUpdate(update) = update else {
                panic!("expected tool call update");
            };
            assert_eq!(update.fields.status, Some(expected_status));
            assert_eq!(
                update
                    .fields
                    .raw_output
                    .as_ref()
                    .and_then(|value| value[ACP_TOOL_CALL_CANCELLED_MARKER].as_bool())
                    .unwrap_or(false),
                expected_cancelled_marker,
            );
        }
    }
    #[test]
    fn maps_history_messages_to_conversation_chunks() {
        let user = DurableEventPayload::UserMessage {
            message_id: astrcode_core::types::new_message_id(),
            text: "hello".into(),
            attachments: vec![],
            accepted_seq: None,
        };
        let assistant = DurableEventPayload::AssistantMessageCompleted {
            message_id: astrcode_core::types::new_message_id(),
            text: "hi there".into(),
            reasoning_content: None,
        };

        let SessionUpdate::UserMessageChunk(chunk) =
            to_history_notification("session-1", &user).unwrap().update
        else {
            panic!("expected user message chunk");
        };
        let ContentBlock::Text(text) = chunk.content else {
            panic!("expected text block");
        };
        assert_eq!(text.text, "hello");

        let SessionUpdate::AgentMessageChunk(chunk) =
            to_history_notification("session-1", &assistant)
                .unwrap()
                .update
        else {
            panic!("expected agent message chunk");
        };
        let ContentBlock::Text(text) = chunk.content else {
            panic!("expected text block");
        };
        assert_eq!(text.text, "hi there");

        let tool = DurableEventPayload::ToolCallCompleted {
            call_id: "call-1".into(),
            tool_name: "probe".into(),
            result: ToolResult::success("done"),
            arguments: String::new(),
            arguments_json: None,
        };
        assert!(matches!(
            to_history_notification("session-1", &tool).map(|notification| notification.update),
            Some(SessionUpdate::ToolCallUpdate(_))
        ));
    }
}
