//! Agent 回写卡片的工具。
//!
//! agent 唯一必须表达的是「做完了」或「卡住了」，因此工具只接受终态列；
//! 运行中列由自动化独占，不接受 agent 写入。

use std::sync::Arc;

use astrcode_extension_sdk::{
    builder::ExtensionToolDefinition,
    extension::{ExtensionError, ToolContext, ToolHandler, ToolPlanContext},
    tool::{
        ToolDefinition, ToolExecutionResult, ToolOrigin, ToolPlan, ToolPromptMetadata,
        ToolPromptTag, ToolResult,
    },
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    RuntimeHolder,
    automation::KanbanRuntime,
    board::{BoardStoreError, CardColumn, now_rfc3339},
};

pub const KANBAN_UPDATE_CARD_TOOL_NAME: &str = "kanban_update_card";

const KANBAN_UPDATE_CARD_DESCRIPTION: &str =
    "Report the outcome of the kanban card you are working on.\n\nWhen NOT to use:\n- The card is \
     still being worked on\n- You have not verified that the requirement is \
     satisfied\n\nRules:\n- Call this exactly once, after the card's requirement is satisfied and \
     verified, or when you are truly blocked.\n- Only the card bound to the current session can \
     be updated.";

/// agent 可写入的终态列。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum UpdateCardColumn {
    Done,
    Blocked,
}

impl UpdateCardColumn {
    fn into_column(self) -> CardColumn {
        match self {
            Self::Done => CardColumn::Done,
            Self::Blocked => CardColumn::Blocked,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateCardArgs {
    card_id: String,
    column: UpdateCardColumn,
    #[serde(default)]
    note: Option<String>,
}

pub fn tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: KANBAN_UPDATE_CARD_TOOL_NAME.into(),
        description: KANBAN_UPDATE_CARD_DESCRIPTION.into(),
        parameters: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "cardId": {
                    "type": "string",
                    "description": "Id of the kanban card bound to this session."
                },
                "column": {
                    "type": "string",
                    "enum": ["done", "blocked"],
                    "description": "Use done when the requirement is satisfied and verified; use blocked only when you cannot make meaningful progress without user input."
                },
                "note": {
                    "type": "string",
                    "description": "Optional short note explaining the outcome or the blocker."
                }
            },
            "required": ["cardId", "column"]
        }),
        strict: true,
        origin: ToolOrigin::Bundled,
    }
}

pub fn tool_registration(
    runtime: RuntimeHolder,
) -> (ExtensionToolDefinition, Arc<dyn ToolHandler>) {
    let definition = ExtensionToolDefinition::from_definition(tool_definition())
        .with_prompt(ToolPromptMetadata::new(String::new()).prompt_tag(ToolPromptTag::Planning));
    (definition, Arc::new(KanbanUpdateCardHandler { runtime }))
}

struct KanbanUpdateCardHandler {
    runtime: RuntimeHolder,
}

#[async_trait::async_trait]
impl ToolHandler for KanbanUpdateCardHandler {
    async fn plan(&self, _ctx: ToolPlanContext) -> Result<ToolPlan, ExtensionError> {
        // 卡片写在扩展自有数据目录，不经过 Host 中介。
        Ok(ToolPlan::opaque())
    }

    async fn execute(&self, ctx: ToolContext) -> Result<ToolExecutionResult, ExtensionError> {
        let args: UpdateCardArgs = ctx.arguments()?;
        let Some(runtime) = self.runtime.lock().clone() else {
            return Ok(ToolResult::error("看板扩展尚未启动，无法更新卡片").into());
        };

        let session_id = ctx.session_id().to_string();
        let column = args.column.into_column();
        let result = update_card(&runtime, &args.card_id, &session_id, column, args.note);
        Ok(match result {
            Ok(card) => ToolResult::success(format!("卡片 {} 已更新为 {:?}", card.id, card.column)),
            Err(error) => ToolResult::error(error.to_string()),
        }
        .into())
    }
}

fn update_card(
    runtime: &KanbanRuntime,
    card_id: &str,
    session_id: &str,
    column: CardColumn,
    note: Option<String>,
) -> Result<crate::board::Card, BoardStoreError> {
    runtime.store().mutate(|board| {
        let Some(card) = board.cards.iter_mut().find(|card| card.id == card_id) else {
            return Err(BoardStoreError::CardNotFound(card_id.to_string()));
        };
        if card.session_id.as_deref() != Some(session_id) {
            return Err(BoardStoreError::CardNotOwned {
                card_id: card_id.to_string(),
            });
        }
        if card.column.is_terminal() {
            return Ok(card.clone());
        }
        card.column = column;
        card.note = note;
        card.updated_at = now_rfc3339();
        Ok(card.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schema_only_accepts_terminal_columns() {
        let definition = tool_definition();
        let columns = definition.parameters["properties"]["column"]["enum"]
            .as_array()
            .expect("column enum")
            .clone();
        assert_eq!(columns, vec![json!("done"), json!("blocked")]);
        assert!(definition.strict);
    }

    #[test]
    fn arguments_reject_running_columns_and_unknown_fields() {
        serde_json::from_value::<UpdateCardArgs>(json!({
            "cardId": "card-1",
            "column": "implementing"
        }))
        .expect_err("running columns must not be agent-writable");

        serde_json::from_value::<UpdateCardArgs>(json!({
            "cardId": "card-1",
            "column": "done",
            "unexpected": true
        }))
        .expect_err("unknown fields must be rejected");
    }

    #[test]
    fn arguments_accept_a_terminal_column_without_a_note() {
        let args: UpdateCardArgs =
            serde_json::from_value(json!({ "cardId": "card-1", "column": "done" }))
                .expect("minimal arguments must be accepted");
        assert_eq!(args.card_id, "card-1");
        assert_eq!(args.column, UpdateCardColumn::Done);
        assert_eq!(args.note, None);
    }
}
