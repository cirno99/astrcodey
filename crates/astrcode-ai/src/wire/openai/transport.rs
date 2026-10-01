//! OpenAI-compatible streaming transport.

use std::sync::atomic::{AtomicBool, Ordering};

use astrcode_core::{
    config::OpenAiApiMode,
    llm::{LlmError, LlmEvent},
};
use tokio::sync::mpsc;

use super::parser::{StandardAccumulator, emit_done_once, process_sse_line};
use crate::common::{ConnectionSnapshot, HttpPostRequest, consume_sse_lines, ensure_header};

pub(crate) async fn stream_request(
    client: reqwest::Client,
    endpoint: String,
    snapshot: ConnectionSnapshot,
    body: serde_json::Value,
    api_mode: OpenAiApiMode,
    tx: mpsc::UnboundedSender<LlmEvent>,
) -> Result<(), LlmError> {
    let mut headers = snapshot.headers;
    ensure_header(&mut headers, "Accept", "text/event-stream");
    let stream_started = AtomicBool::new(false);
    let stream_replay_safe = AtomicBool::new(true);

    HttpPostRequest {
        client,
        endpoint,
        headers,
        body,
        retry: snapshot.retry,
    }
    .run(&stream_started, &stream_replay_safe, &tx, |response| {
        parse_stream(
            response,
            api_mode,
            &tx,
            &stream_started,
            &stream_replay_safe,
        )
    })
    .await
}

async fn parse_stream(
    response: reqwest::Response,
    api_mode: OpenAiApiMode,
    tx: &mpsc::UnboundedSender<LlmEvent>,
    stream_started: &AtomicBool,
    stream_replay_safe: &AtomicBool,
) -> Result<(), LlmError> {
    let mut accumulator = StandardAccumulator::default();
    let mut has_data_line = false;
    let completed = consume_sse_lines(response, tx, |line| {
        stream_started.store(true, Ordering::SeqCst);
        if line.trim().starts_with("data:") {
            has_data_line = true;
        }
        process_sse_line(line, &mut accumulator, api_mode, tx);
        if accumulator.has_started_tool_call() {
            stream_replay_safe.store(false, Ordering::SeqCst);
        }
        !tx.is_closed()
    })
    .await?;
    // 流内错误事件已终止本次响应；交给共享传输层决定重放还是上报。
    if let Some(message) = accumulator.take_stream_error() {
        return Err(LlmError::StreamDisconnected { message });
    }
    let Some(summary) = completed else {
        return Ok(());
    };
    summary.require_data_lines(has_data_line)?;
    if !accumulator.done_sent() && !tx.is_closed() {
        emit_done_once(&mut accumulator, tx);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use astrcode_core::{
        config::OpenAiApiMode,
        llm::{LlmError, LlmEvent},
    };
    use tokio::sync::mpsc;

    use super::*;
    use crate::common::spawn_test_server;

    async fn parse_from_server(
        body: Vec<u8>,
    ) -> (Result<(), LlmError>, mpsc::UnboundedReceiver<LlmEvent>) {
        let (addr, _requests) = spawn_test_server(move |_| body.clone()).await;
        let client = reqwest::Client::new();
        let response = client.post(&addr).body("{}").send().await.unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let stream_started = AtomicBool::new(false);
        let stream_replay_safe = AtomicBool::new(true);
        let result = parse_stream(
            response,
            OpenAiApiMode::Responses,
            &tx,
            &stream_started,
            &stream_replay_safe,
        )
        .await;
        (result, rx)
    }

    #[tokio::test]
    async fn parse_stream_rejects_200_response_without_data_lines() {
        let result = parse_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n<html>gateway error page</html>".to_vec(),
        )
        .await;
        assert!(matches!(result.0, Err(LlmError::StreamParse { .. })));
    }

    #[tokio::test]
    async fn parse_stream_accepts_valid_sse() {
        let (result, mut rx) = parse_from_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\ndata: [DONE]\n\n".to_vec(),
        )
        .await;
        assert!(result.is_ok());
        let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, LlmEvent::ContentDelta { delta } if delta == "hi"))
        );
        assert!(events.iter().any(|e| matches!(e, LlmEvent::Done { .. })));
    }

    /// provider 在流内下发瞬态错误事件时，传输层按可重放中断重试，turn 不会先失败。
    #[tokio::test]
    async fn transient_stream_error_is_retried_while_the_stream_is_replay_safe() {
        let (addr, requests) = spawn_test_server(|request| {
            if request == 1 {
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"error\":{\"message\":\"terminated by the server\"}}\n\n"
                    .to_vec()
            } else {
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: [DONE]\n\n"
                    .to_vec()
            }
        })
        .await;
        let stream_started = AtomicBool::new(false);
        let stream_replay_safe = AtomicBool::new(true);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let result = crate::common::HttpPostRequest {
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("build local test client"),
            endpoint: addr,
            headers: Vec::new(),
            body: serde_json::json!({}),
            retry: crate::retry::RetryPolicy {
                base_delay_ms: 1,
                max_delay_ms: 100,
                ..crate::retry::RetryPolicy::default()
            },
        }
        .run(&stream_started, &stream_replay_safe, &tx, |response| {
            let tx = &tx;
            let stream_started = &stream_started;
            let stream_replay_safe = &stream_replay_safe;
            async move {
                parse_stream(
                    response,
                    OpenAiApiMode::ChatCompletions,
                    tx,
                    stream_started,
                    stream_replay_safe,
                )
                .await
            }
        })
        .await;

        assert!(result.is_ok(), "可重放的流内中断必须重试: {result:?}");
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(
            matches!(
                events.as_slice(),
                [
                    LlmEvent::Retrying {
                        status: None,
                        attempt: 1,
                        ..
                    },
                    LlmEvent::RetryRecovered,
                    LlmEvent::Done { .. }
                ]
            ),
            "unexpected events: {events:?}"
        );
    }
}
