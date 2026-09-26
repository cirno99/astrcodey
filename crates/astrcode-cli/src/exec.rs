//! 无头执行模式 —— 单次提示执行（进程内）。
//!
//! 该模块实现了 CLI 的 `exec` 子命令，用于在不需要交互式 TUI 的情况下
//! 一次性提交提示并输出结果。支持纯文本和 JSONL 两种输出格式，
//! 并可通过 [`ResumeTarget`] 续接既有会话。

use std::io::{IsTerminal, Read, Write};

use astrcode_client::{
    client::AstrcodeClient,
    error::ClientError,
    stream::{ConversationStream, StreamError},
    transport::ClientTransport,
};
use astrcode_core::event::{DurableEventPayload, EventPayload, LiveEventPayload};
use astrcode_protocol::{
    commands::ClientCommand,
    events::{ClientNotification, SessionListItemDto},
};
use thiserror::Error;

use crate::{transport::InProcessTransport, tui::store::session_picker::canonicalize_working_dir};

#[derive(Debug, Error)]
pub enum ExecError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Stream(#[from] StreamError),
    #[error("exec timed out after {0}s")]
    Timeout(u64),
    #[error("write stdout: {0}")]
    WriteStdout(#[from] std::io::Error),
    #[error("serialize jsonl: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("read stdin: {0}")]
    ReadStdin(std::io::Error),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("no resumable session")]
    NoResumableSession,
    #[error("prompt is empty and no session to resume")]
    EmptyPrompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationAction {
    Continue,
    Finish,
}

/// exec 的会话恢复目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeTarget {
    /// 恢复指定会话。
    Session(String),
    /// 恢复最近一次会话；`all` 为真时不按工作目录过滤。
    Last { all: bool },
}

/// 执行单次提示（或仅恢复会话）并等待响应完成。
pub async fn run(
    prompt: Option<String>,
    resume: Option<ResumeTarget>,
    jsonl: bool,
    timeout_secs: u64,
    bootstrap_opts: astrcode_server::bootstrap::BootstrapOptions,
) -> Result<(), ExecError> {
    let prompt = resolve_prompt(
        prompt,
        std::io::stdin().is_terminal(),
        &mut std::io::stdin(),
    )?;
    let prompt = match prompt {
        Some(text) if !text.trim().is_empty() => Some(text),
        _ => None,
    };
    if prompt.is_none() && resume.is_none() {
        return Err(ExecError::EmptyPrompt);
    }

    let client = AstrcodeClient::new(InProcessTransport::start_with(bootstrap_opts));

    // 先订阅再建立或恢复会话，否则会漏掉此前发出的 SessionResumed 快照。
    let mut stream = client.subscribe_events().await?;

    let deadline = (timeout_secs > 0)
        .then(|| tokio::time::Instant::now() + tokio::time::Duration::from_secs(timeout_secs));

    match resume {
        Some(target) => {
            resume_session(&client, &mut stream, target, jsonl, deadline, timeout_secs).await?;
        },
        None => {
            let _sid = client.create_session(".").await?;
        },
    }

    let Some(text) = prompt else {
        return Ok(());
    };

    client
        .send_command(&ClientCommand::SubmitPrompt {
            text,
            attachments: vec![],
        })
        .await?;

    loop {
        let notification = recv_notification(&mut stream, deadline, timeout_secs).await?;
        let action = render_notification(
            &notification,
            jsonl,
            &mut std::io::stdout(),
            &mut std::io::stderr(),
        )?;
        if action == NotificationAction::Finish {
            break;
        }
    }
    Ok(())
}

/// 恢复会话；`ResumeTarget::Last` 先通过会话列表定位最近一次会话。
async fn resume_session<T: ClientTransport>(
    client: &AstrcodeClient<T>,
    stream: &mut ConversationStream,
    target: ResumeTarget,
    jsonl: bool,
    deadline: Option<tokio::time::Instant>,
    timeout_secs: u64,
) -> Result<(), ExecError> {
    let session_id = match target {
        ResumeTarget::Session(session_id) => session_id,
        ResumeTarget::Last { all } => {
            client.send_command(&ClientCommand::ListSessions).await?;
            loop {
                let notification = recv_notification(stream, deadline, timeout_secs).await?;
                if jsonl {
                    write_jsonl(&notification, &mut std::io::stdout())?;
                }
                if let ClientNotification::SessionList { sessions } = &notification {
                    break pick_latest_session(sessions, all)
                        .ok_or(ExecError::NoResumableSession)?;
                }
            }
        },
    };

    client
        .send_command(&ClientCommand::ResumeSession {
            session_id: session_id.clone(),
        })
        .await?;

    loop {
        let notification = recv_notification(stream, deadline, timeout_secs).await?;
        match &notification {
            ClientNotification::SessionResumed { .. } => {
                render_notification(
                    &notification,
                    jsonl,
                    &mut std::io::stdout(),
                    &mut std::io::stderr(),
                )?;
                return Ok(());
            },
            ClientNotification::Error { message, .. } => {
                return Err(ExecError::SessionNotFound(format!(
                    "{session_id}: {message}"
                )));
            },
            _ => {
                if jsonl {
                    write_jsonl(&notification, &mut std::io::stdout())?;
                }
            },
        }
    }
}

/// 等待下一条通知；`deadline` 为 `None` 时不限时。
async fn recv_notification(
    stream: &mut ConversationStream,
    deadline: Option<tokio::time::Instant>,
    timeout_secs: u64,
) -> Result<ClientNotification, ExecError> {
    let received = match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, stream.recv())
            .await
            .map_err(|_| ExecError::Timeout(timeout_secs))?,
        None => stream.recv().await,
    };
    Ok(received?)
}

/// 选择最近活跃的会话；`all` 为假时只考虑当前工作目录下的会话。
fn pick_latest_session(sessions: &[SessionListItemDto], all: bool) -> Option<String> {
    let cwd = canonicalize_working_dir(
        &std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| ".".into()),
    );
    // last_active_at 是 ISO 8601 时间串，字典序即时间先后（与 TUI session picker 一致）。
    sessions
        .iter()
        .filter(|session| all || canonicalize_working_dir(&session.working_dir) == cwd)
        .max_by(|a, b| a.last_active_at.cmp(&b.last_active_at))
        .map(|session| session.session_id.clone())
}

/// 解析提示文本：位置参数缺省或为 `-` 时读 stdin；
/// 位置参数与管道 stdin 并存时，stdin 追加为 `<stdin>` 块。
fn resolve_prompt(
    positional: Option<String>,
    stdin_is_terminal: bool,
    stdin: &mut impl Read,
) -> Result<Option<String>, ExecError> {
    let piped = !stdin_is_terminal;
    match positional.as_deref() {
        Some("-") => Ok(Some(read_stdin(stdin)?)),
        Some(text) if piped => Ok(Some(format!(
            "{text}\n\n<stdin>\n{}\n</stdin>",
            read_stdin(stdin)?
        ))),
        Some(_) => Ok(positional),
        None if piped => Ok(Some(read_stdin(stdin)?)),
        None => Ok(None),
    }
}

fn read_stdin(stdin: &mut impl Read) -> Result<String, ExecError> {
    let mut text = String::new();
    stdin
        .read_to_string(&mut text)
        .map_err(ExecError::ReadStdin)?;
    Ok(text)
}

fn render_notification(
    notification: &ClientNotification,
    jsonl: bool,
    out: &mut impl Write,
    err: &mut impl Write,
) -> Result<NotificationAction, ExecError> {
    if jsonl {
        write_jsonl(notification, out)?;
        return Ok(notification_action(notification));
    }

    match notification {
        ClientNotification::Event(core_event) => match &core_event.payload {
            EventPayload::Live(LiveEventPayload::AssistantTextDelta { delta, .. }) => {
                write!(out, "{delta}")?;
                Ok(NotificationAction::Continue)
            },
            EventPayload::Durable(DurableEventPayload::TurnCompleted { .. }) => {
                writeln!(out)?;
                Ok(NotificationAction::Finish)
            },
            EventPayload::Durable(DurableEventPayload::ErrorOccurred { message, .. })
            | EventPayload::Live(LiveEventPayload::ErrorOccurred { message, .. }) => {
                writeln!(err, "Error: {message}")?;
                Ok(NotificationAction::Finish)
            },
            _ => Ok(NotificationAction::Continue),
        },
        ClientNotification::Error { message, .. } => {
            writeln!(err, "Error: {message}")?;
            Ok(NotificationAction::Finish)
        },
        _ => Ok(NotificationAction::Continue),
    }
}

fn write_jsonl(notification: &ClientNotification, out: &mut impl Write) -> Result<(), ExecError> {
    serde_json::to_writer(&mut *out, notification)?;
    writeln!(out)?;
    Ok(())
}

fn notification_action(notification: &ClientNotification) -> NotificationAction {
    match notification {
        ClientNotification::Event(core_event) => match core_event.payload {
            EventPayload::Durable(
                DurableEventPayload::TurnCompleted { .. }
                | DurableEventPayload::ErrorOccurred { .. },
            )
            | EventPayload::Live(LiveEventPayload::ErrorOccurred { .. }) => {
                NotificationAction::Finish
            },
            _ => NotificationAction::Continue,
        },
        ClientNotification::Error { .. } => NotificationAction::Finish,
        _ => NotificationAction::Continue,
    }
}

#[cfg(test)]
mod tests {
    use astrcode_core::{
        event::{
            DurableEvent, DurableEventPayload, EventPayload, LiveEvent, LiveEventPayload,
            StoredEvent,
        },
        types::SessionId,
    };

    use super::*;

    fn notification(payload: EventPayload) -> ClientNotification {
        let event = match payload {
            EventPayload::Durable(payload) => StoredEvent::new(
                1,
                DurableEvent::session(SessionId::from("session-1"), payload),
            )
            .into(),
            EventPayload::Live(payload) => {
                LiveEvent::session(SessionId::from("session-1"), payload).into()
            },
        };
        ClientNotification::Event(event)
    }

    #[test]
    fn jsonl_output_includes_streaming_delta() {
        let notification = notification(EventPayload::Live(LiveEventPayload::AssistantTextDelta {
            message_id: "message-1".into(),
            delta: "hello".into(),
        }));
        let mut out = Vec::new();
        let mut err = Vec::new();

        let action = render_notification(&notification, true, &mut out, &mut err).unwrap();

        let line: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(line["event"], "event");
        assert_eq!(line["data"]["payload"]["type"], "assistant_text_delta");
        assert_eq!(line["data"]["payload"]["delta"], "hello");
        assert!(err.is_empty());
        assert_eq!(action, NotificationAction::Continue);
    }

    #[test]
    fn jsonl_output_includes_turn_completion_before_finishing() {
        let notification =
            notification(EventPayload::Durable(DurableEventPayload::TurnCompleted {
                finish_reason: "stop".into(),
            }));
        let mut out = Vec::new();
        let mut err = Vec::new();

        let action = render_notification(&notification, true, &mut out, &mut err).unwrap();

        let line: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(line["data"]["payload"]["type"], "turn_completed");
        assert!(err.is_empty());
        assert_eq!(action, NotificationAction::Finish);
    }

    #[test]
    fn text_output_keeps_plain_transcript_behavior() {
        let notification = notification(EventPayload::Live(LiveEventPayload::AssistantTextDelta {
            message_id: "message-1".into(),
            delta: "hello".into(),
        }));
        let mut out = Vec::new();
        let mut err = Vec::new();

        let action = render_notification(&notification, false, &mut out, &mut err).unwrap();

        assert_eq!(String::from_utf8(out).unwrap(), "hello");
        assert!(err.is_empty());
        assert_eq!(action, NotificationAction::Continue);
    }
    fn session_item(
        session_id: &str,
        working_dir: &str,
        last_active_at: &str,
    ) -> SessionListItemDto {
        SessionListItemDto {
            session_id: session_id.into(),
            last_active_at: last_active_at.into(),
            working_dir: working_dir.into(),
            parent_session_id: None,
            title: None,
        }
    }

    #[test]
    fn resolve_prompt_reads_stdin_when_positional_is_absent() {
        let mut stdin = "piped".as_bytes();

        let resolved = resolve_prompt(None, false, &mut stdin).unwrap();

        assert_eq!(resolved.as_deref(), Some("piped"));
    }

    #[test]
    fn resolve_prompt_reads_stdin_for_dash_sentinel() {
        let mut stdin = "from stdin".as_bytes();

        let resolved = resolve_prompt(Some("-".into()), true, &mut stdin).unwrap();

        assert_eq!(resolved.as_deref(), Some("from stdin"));
    }

    #[test]
    fn resolve_prompt_appends_piped_stdin_to_positional_prompt() {
        let mut stdin = "extra".as_bytes();

        let resolved = resolve_prompt(Some("question".into()), false, &mut stdin).unwrap();

        assert_eq!(
            resolved.as_deref(),
            Some("question\n\n<stdin>\nextra\n</stdin>")
        );
    }

    #[test]
    fn resolve_prompt_returns_none_without_stdin_or_positional_prompt() {
        let mut stdin = "".as_bytes();

        assert_eq!(resolve_prompt(None, true, &mut stdin).unwrap(), None);
    }

    #[test]
    fn pick_latest_session_prefers_newest_session_in_working_dir() {
        let sessions = vec![
            session_item("old", ".", "2026-09-25T10:00:00Z"),
            session_item("new", ".", "2026-09-26T10:00:00Z"),
            session_item("elsewhere", "/elsewhere", "2026-09-27T10:00:00Z"),
        ];

        assert_eq!(pick_latest_session(&sessions, false), Some("new".into()));
    }

    #[test]
    fn pick_latest_session_ignores_working_dir_when_all_is_set() {
        let sessions = vec![
            session_item("old", ".", "2026-09-25T10:00:00Z"),
            session_item("elsewhere", "/elsewhere", "2026-09-26T10:00:00Z"),
        ];

        assert_eq!(
            pick_latest_session(&sessions, true),
            Some("elsewhere".into())
        );
    }

    #[test]
    fn pick_latest_session_returns_none_without_candidate() {
        let sessions = vec![session_item(
            "elsewhere",
            "/elsewhere",
            "2026-09-26T10:00:00Z",
        )];

        assert_eq!(pick_latest_session(&sessions, false), None);
        assert_eq!(pick_latest_session(&[], true), None);
    }
}
