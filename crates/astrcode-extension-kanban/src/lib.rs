//! 看板扩展：需求卡片驱动的自动化任务。
//!
//! 用户在看的板页上写下需求，扩展在后台按固定间隔领取 `ready` 卡片，创建 root session
//! 先做分析、再做实施，直到卡片被 agent 标记为终态。
//!
//! 本扩展只依赖插件系统：看板数据落在扩展全局数据目录，会话通过 `input_delivery`
//! 宿主接口投递，前端通过认证 HTTP 路由读写。

mod automation;
mod board;
mod config;
mod directory;
mod failure;
mod http;
mod prompt;
mod tool;

use std::sync::Arc;

use astrcode_extension_sdk::{
    builder::manifest,
    extension::{
        ContinueAfterStopContext, ContinueAfterStopHandler, ContinueAfterStopOptions,
        ContinueAfterStopResult, Extension, ExtensionCall, ExtensionCapability, ExtensionConfig,
        ExtensionError, ExtensionHttpHandler, ExtensionManifest, ExtensionStartContext,
        ExtensionStopContext, Registrar, TransportFeature,
    },
};
use parking_lot::Mutex;

use crate::{
    automation::KanbanRuntime, board::BoardStore, config::KanbanConfig, http::KanbanHttpHandler,
};

const EXTENSION_ID: &str = "astrcode-kanban";
const AUTOMATION_TASK_NAME: &str = "kanban-automation";

/// 单轮续跑次数的硬上限。
///
/// 可配置上限在 handler 内生效；这里的常量只是防止 handler 出 bug 后无限续跑的第二道闸门。
const HARD_CONTINUATION_LIMIT: u32 = 200;

/// 运行期句柄：`register()` 早于 `start()`，因此 handler 只能持有可空的间接引用。
type RuntimeHolder = Arc<Mutex<Option<Arc<KanbanRuntime>>>>;

pub fn extension() -> Arc<dyn Extension> {
    Arc::new(KanbanExtension::new())
}

/// 校验候选配置，不构造运行期状态。
pub fn validate_config(config: &ExtensionConfig) -> Result<(), ExtensionError> {
    let config: KanbanConfig = config.deserialize_or_default()?;
    config.validate()
}

struct KanbanExtension {
    runtime: RuntimeHolder,
}

impl KanbanExtension {
    fn new() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(None)),
        }
    }
}

#[async_trait::async_trait]
impl Extension for KanbanExtension {
    fn manifest(&self) -> ExtensionManifest {
        manifest(EXTENSION_ID)
            .version(env!("CARGO_PKG_VERSION"))
            .description(env!("CARGO_PKG_DESCRIPTION"))
            .requires_transport(TransportFeature::AuthenticatedHttp)
            .capability(ExtensionCapability::AuthenticatedHttp)
            .capability(ExtensionCapability::InputDelivery)
            .capability(ExtensionCapability::TurnContinuationControl)
            .build()
    }

    fn register(&self, registrar: &mut Registrar) {
        let (definition, handler) = tool::tool_registration(Arc::clone(&self.runtime));
        registrar.tool(definition, handler);

        let http = Arc::new(KanbanHttpHandler::new(Arc::clone(&self.runtime)));
        for route in http::routes() {
            registrar.http_route(route, Arc::clone(&http) as Arc<dyn ExtensionHttpHandler>);
        }

        registrar.on_continue_after_stop(
            60,
            ContinueAfterStopOptions::limited(HARD_CONTINUATION_LIMIT),
            Arc::new(KanbanContinueAfterStopHandler {
                runtime: Arc::clone(&self.runtime),
            }),
        );
    }

    fn validate_config(&self, config: &ExtensionConfig) -> Result<(), ExtensionError> {
        validate_config(config)
    }

    async fn start(&self, ctx: ExtensionStartContext) -> Result<(), ExtensionError> {
        let config: KanbanConfig = ctx.config().deserialize_or_default()?;
        config.validate()?;

        let data_dir = ctx.paths().global_data_dir().ok_or_else(|| {
            ExtensionError::Internal("看板扩展需要全局数据目录来持久化看板".into())
        })?;
        let session_control = ctx.host().session_control().map_err(|error| {
            ExtensionError::Internal(format!("看板扩展需要 input-delivery 宿主接口: {error}"))
        })?;

        let runtime = Arc::new(KanbanRuntime::new(
            config,
            BoardStore::new(data_dir),
            session_control,
        ));
        *self.runtime.lock() = Some(Arc::clone(&runtime));

        if runtime.config().automation_enabled {
            ctx.tasks().spawn(
                AUTOMATION_TASK_NAME,
                automation::automation_loop(Arc::clone(&runtime), ctx.tasks().clone()),
            );
            tracing::info!(extension_id = EXTENSION_ID, "kanban automation started");
        } else {
            tracing::info!(
                extension_id = EXTENSION_ID,
                "kanban automation is disabled; the board stays read/write only"
            );
        }
        Ok(())
    }

    async fn stop(&self, _ctx: ExtensionStopContext) -> Result<(), ExtensionError> {
        self.runtime.lock().take();
        Ok(())
    }
}

struct KanbanContinueAfterStopHandler {
    runtime: RuntimeHolder,
}

#[async_trait::async_trait]
impl ContinueAfterStopHandler for KanbanContinueAfterStopHandler {
    async fn handle(
        &self,
        ctx: ContinueAfterStopContext,
    ) -> Result<ContinueAfterStopResult, ExtensionError> {
        let Some(runtime) = self.runtime.lock().clone() else {
            return Ok(ContinueAfterStopResult::EndTurn);
        };
        if ctx.continuations_this_turn() >= runtime.config().max_continuations_per_turn {
            return Ok(ContinueAfterStopResult::EndTurn);
        }
        let implementing = runtime
            .card_is_implementing(ctx.session_id().as_str())
            .map_err(|error| ExtensionError::Internal(error.to_string()))?;
        Ok(if implementing {
            ContinueAfterStopResult::ContinueOneStep
        } else {
            ContinueAfterStopResult::EndTurn
        })
    }
}

#[cfg(test)]
mod tests {
    use astrcode_extension_sdk::extension::Registrar;

    use super::*;
    use crate::tool::KANBAN_UPDATE_CARD_TOOL_NAME;

    #[test]
    fn registrations_match_the_manifest_and_expose_the_expected_surface() {
        let extension = KanbanExtension::new();
        let mut registrar = Registrar::new();
        extension.register(&mut registrar);
        let (_, registrations) = registrar
            .finish(extension.manifest())
            .expect("registrations must match the manifest");

        let tool_names: Vec<&str> = registrations
            .tools()
            .iter()
            .map(|registration| registration.definition().name.as_str())
            .collect();
        assert_eq!(tool_names, vec![KANBAN_UPDATE_CARD_TOOL_NAME]);

        assert_eq!(registrations.http_routes().len(), http::routes().len());
        assert_eq!(registrations.continue_after_stop().len(), 1);
    }
}
