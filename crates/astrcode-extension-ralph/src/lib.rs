//! astrcode-extension-ralph — Ralph 循环。
//!
//! 模型每次自然停下后，把工作区任务文件的全文重新注入上下文，直到它打印出完成承诺、
//! 用尽迭代预算，或者撞上熔断。
//!
//! 状态在 `<session_data_dir>/loops/<name>.json`；任务文件在工作区 `.ralph/<name>.md`。

mod command;
mod hook;
mod plan;
mod prompt;
mod state;
#[cfg(test)]
mod tests;

use std::sync::Arc;

use astrcode_extension_sdk::{
    builder::manifest,
    extension::{
        CommandAvailability, CommandExecution, ContinueAfterStopOptions, Extension,
        ExtensionCapability, ExtensionManifest, HookMode, LifecycleEvent, Registrar, SlashCommand,
    },
};

use crate::{
    command::RalphCommandHandler,
    hook::{
        RalphContinueAfterStopHandler, RalphRuntime, RalphToolActivityHandler,
        RalphUserPromptHandler,
    },
};

const EXTENSION_ID: &str = "astrcode-ralph";

/// 续跑优先级：高于 goal(40)，低于看板(60)。
///
/// 宿主在首个 `ContinueOneStep` 处提前返回，所以这个数字是与看板、goal、sleep-continue
/// 共存的唯一杠杆：看板在驱动会话时 Ralph 的判定根本不会被调用，Ralph 进行中时
/// sleep-continue(0) 与 goal(40) 也不会生效（`/ralph status` 会说明这件事）。
const CONTINUE_PRIORITY: i32 = 50;

/// 返回内置的 Ralph 循环扩展。
pub fn extension() -> Arc<dyn Extension> {
    Arc::new(RalphExtension)
}

struct RalphExtension;

#[async_trait::async_trait]
impl Extension for RalphExtension {
    fn manifest(&self) -> ExtensionManifest {
        manifest(EXTENSION_ID)
            .version(env!("CARGO_PKG_VERSION"))
            .description(env!("CARGO_PKG_DESCRIPTION"))
            .capability(ExtensionCapability::SessionControl)
            .capability(ExtensionCapability::WorkspaceRead)
            .capability(ExtensionCapability::WorkspaceWrite)
            .capability(ExtensionCapability::TurnContinuationControl)
            .build()
    }

    fn register(&self, reg: &mut Registrar) {
        let runtime = Arc::new(RalphRuntime::new());

        // 声明 `unlimited`：宿主的每轮上限到顶后连 handler 都不再调用，扩展就失去了
        // 「把为什么停下记下来」的机会；迭代预算由扩展自己按 `max_iterations` 判定。
        reg.on_continue_after_stop(
            CONTINUE_PRIORITY,
            ContinueAfterStopOptions::unlimited(),
            Arc::new(RalphContinueAfterStopHandler::new(Arc::clone(&runtime))),
        );

        // 工具活动只是观测：不拦任何调用，也不改任何结果。
        reg.on_post_tool_use(
            HookMode::NonBlocking,
            0,
            Arc::new(RalphToolActivityHandler::new(Arc::clone(&runtime))),
        );

        // 人工插话重置熔断链。
        reg.on_lifecycle(
            LifecycleEvent::UserPromptSubmit,
            HookMode::NonBlocking,
            0,
            Arc::new(RalphUserPromptHandler::new(runtime)),
        );

        reg.command(
            SlashCommand {
                name: "ralph".into(),
                description: "Ralph 循环：模型每次停下后重新喂一遍任务文件，直到它打印完成承诺。/\
                              ralph start <name> 开始，/ralph status 看状态。"
                    .into(),
                args_schema: None,
                // `cancel` 必须能在 turn 运行中执行——那是这个循环唯一的逃生通道。
                requires_idle: false,
                argument_completions: false,
                priority: 0,
                availability: CommandAvailability::AllTransports,
                execution: CommandExecution::Extension,
            },
            Arc::new(RalphCommandHandler),
        );
    }
}
