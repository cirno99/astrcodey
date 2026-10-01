//! 端到端测试：用记录型宿主把 `/ralph start` 与续跑判定串起来跑一遍。
//!
//! 放在 crate 内而不是 `tests/`：被测的 handler 与 store 都是 `pub(crate)`，为了集成测试
//! 把它们公开会白白扩大公开面。

use std::{
    any::Any,
    collections::HashMap,
    sync::{Arc, Mutex},
};

use astrcode_extension_sdk::{
    extension::{
        CommandHandler, ContinueAfterStopHandler, ContinueAfterStopResult, ExtensionCapability,
        ExtensionCommandResult,
    },
    host::{
        HostError, HostOperation,
        internal::{HostInvoker, HostScope, extension_host},
    },
    testing::{CommandContextBuilder, HookContextBuilder},
    wire::{
        WireErrorCode,
        host::{
            HostSessionDeliveryOutput, HostWorkspaceReadOutput, HostWorkspaceTextChange,
            HostWorkspaceWriteOutput,
        },
    },
};
use serde_json::Value;

use crate::{
    EXTENSION_ID,
    command::RalphCommandHandler,
    hook::{RalphContinueAfterStopHandler, RalphRuntime},
};

const SESSION_ID: &str = "session-1";

/// 记录型宿主：只回答任务文件读写与续跑注入，其余操作一律报后端不可用。
#[derive(Default)]
struct RecordingHost {
    files: Mutex<HashMap<String, String>>,
    injected: Mutex<Vec<String>>,
}

impl RecordingHost {
    fn file(&self, path: &str) -> Option<String> {
        self.files.lock().unwrap().get(path).cloned()
    }

    fn injected(&self) -> Vec<String> {
        self.injected.lock().unwrap().clone()
    }
}

fn payload<T: serde::Serialize>(value: T) -> Result<Value, HostError> {
    serde_json::to_value(value)
        .map_err(|error| HostError::new(WireErrorCode::SerializationFailed, error.to_string()))
}

#[async_trait::async_trait]
impl HostInvoker for RecordingHost {
    async fn invoke(&self, operation: HostOperation, input: Value) -> Result<Value, HostError> {
        match operation {
            HostOperation::WorkspaceRead => {
                let path = input
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let content = self
                    .file(&path)
                    .ok_or_else(|| HostError::new(WireErrorCode::IoError, "no such file"))?;
                payload(HostWorkspaceReadOutput::Text {
                    bytes: content.len(),
                    total_lines: content.lines().count(),
                    content,
                    line_offset: 0,
                    returned_lines: 1,
                    has_more_lines: false,
                })
            },
            HostOperation::WorkspaceWrite => {
                let path = input
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let content = input
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let created = self
                    .files
                    .lock()
                    .unwrap()
                    .insert(path.clone(), content.clone())
                    .is_none();
                payload(HostWorkspaceWriteOutput {
                    path,
                    created,
                    change: HostWorkspaceTextChange {
                        old_bytes: None,
                        new_bytes: content.len() as u64,
                        unified_diff: None,
                        insertions: 0,
                        deletions: 0,
                        diff_truncated: false,
                    },
                })
            },
            HostOperation::SessionControlDeferContext => {
                let content = input
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                self.injected.lock().unwrap().push(content);
                payload(HostSessionDeliveryOutput::Injected {
                    turn_id: "turn-1".into(),
                })
            },
            other => Err(HostError::new(
                WireErrorCode::BackendUnavailable,
                format!("{other:?} backend is unavailable in this test context"),
            )),
        }
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

fn scoped_host(host: &Arc<RecordingHost>) -> astrcode_extension_sdk::host::ExtensionHost {
    extension_host(
        Arc::clone(host) as Arc<dyn HostInvoker>,
        HostScope::new(
            [
                ExtensionCapability::SessionControl,
                ExtensionCapability::WorkspaceRead,
                ExtensionCapability::WorkspaceWrite,
                ExtensionCapability::TurnContinuationControl,
            ],
            [
                HostOperation::WorkspaceRead,
                HostOperation::WorkspaceWrite,
                HostOperation::SessionControlDeferContext,
            ],
            true,
            true,
        ),
    )
}

fn command_context(
    host: &Arc<RecordingHost>,
    argument: &str,
) -> astrcode_extension_sdk::extension::CommandContext {
    CommandContextBuilder::new(EXTENSION_ID, "ralph")
        .session(SESSION_ID, ".", Some(std::env::temp_dir()))
        .argument(argument)
        .capability(ExtensionCapability::SessionControl)
        .capability(ExtensionCapability::WorkspaceRead)
        .capability(ExtensionCapability::WorkspaceWrite)
        .capability(ExtensionCapability::TurnContinuationControl)
        .host(scoped_host(host))
        .build()
}

fn continue_context(
    host: &Arc<RecordingHost>,
    assistant_text: &str,
) -> astrcode_extension_sdk::extension::ContinueAfterStopContext {
    HookContextBuilder::new(EXTENSION_ID)
        .session(SESSION_ID, ".", Some(std::env::temp_dir()))
        .turn_id("turn-1")
        .capability(ExtensionCapability::SessionControl)
        .capability(ExtensionCapability::WorkspaceRead)
        .capability(ExtensionCapability::WorkspaceWrite)
        .capability(ExtensionCapability::TurnContinuationControl)
        .host(scoped_host(host))
        .build_continue_after_stop(assistant_text, "stop", 0)
}

async fn display_text(result: ExtensionCommandResult) -> String {
    let ExtensionCommandResult::Display {
        content, is_error, ..
    } = result
    else {
        panic!("expected a display result");
    };
    assert!(!is_error, "unexpected command error: {content}");
    content
}

#[tokio::test]
async fn start_writes_template_then_hook_injects_it_every_round() {
    let host = Arc::new(RecordingHost::default());
    let handler = RalphCommandHandler;

    let text = display_text(
        handler
            .execute(command_context(&host, "start fix-tests --promise DONE"))
            .await
            .unwrap(),
    )
    .await;
    assert!(text.contains("fix-tests"), "{text}");

    let template = host.file(".ralph/fix-tests.md").expect("template written");
    assert!(template.contains("## 目标"), "{template}");

    let hook = RalphContinueAfterStopHandler::new(Arc::new(RalphRuntime::new()));
    let decision = hook
        .handle(continue_context(&host, "我先看一下任务文件。"))
        .await
        .unwrap();
    assert_eq!(decision, ContinueAfterStopResult::ContinueOneStep);

    let injected = host.injected();
    assert_eq!(injected.len(), 1);
    assert!(injected[0].contains("iteration 1/50"), "{}", injected[0]);
    assert!(injected[0].contains("## 目标"), "{}", injected[0]);
    assert!(
        injected[0].contains("<promise>DONE</promise>"),
        "{}",
        injected[0]
    );
}

#[tokio::test]
async fn promise_ends_the_loop_and_later_stops_are_inert() {
    let host = Arc::new(RecordingHost::default());
    RalphCommandHandler
        .execute(command_context(&host, "start fix-tests --promise DONE"))
        .await
        .unwrap();

    let hook = RalphContinueAfterStopHandler::new(Arc::new(RalphRuntime::new()));
    hook.handle(continue_context(&host, "第一轮"))
        .await
        .unwrap();

    let decision = hook
        .handle(continue_context(&host, "全部完成 <promise>DONE</promise>"))
        .await
        .unwrap();
    assert_eq!(decision, ContinueAfterStopResult::EndTurn);
    assert_eq!(host.injected().len(), 1, "承诺命中后不应再注入");

    let status = display_text(
        RalphCommandHandler
            .execute(command_context(&host, "status"))
            .await
            .unwrap(),
    )
    .await;
    assert!(status.contains("已完成"), "{status}");
    assert!(status.contains("命中完成承诺"), "{status}");

    let decision = hook
        .handle(continue_context(&host, "又说话了"))
        .await
        .unwrap();
    assert_eq!(decision, ContinueAfterStopResult::EndTurn);
    assert_eq!(host.injected().len(), 1);
}

#[tokio::test]
async fn empty_task_file_is_refused_instead_of_looping_forever() {
    let host = Arc::new(RecordingHost::default());
    host.files
        .lock()
        .unwrap()
        .insert(".ralph/empty.md".into(), "   \n".into());

    let result = RalphCommandHandler
        .execute(command_context(&host, "start empty"))
        .await
        .unwrap();
    let ExtensionCommandResult::Display {
        content, is_error, ..
    } = result
    else {
        panic!("expected a display result");
    };
    assert!(is_error);
    assert!(content.contains("是空的"), "{content}");
    assert!(content.contains("## 目标"), "应当回显模板：{content}");
}
