//! 看板页使用的认证 HTTP 路由。
//!
//! 这里只做线缆形状的解析与映射：真正的看板状态机在 [`crate::board`]，
//! 自动化在 [`crate::automation`]。运行中列不接受用户写入。

use astrcode_extension_sdk::extension::{
    ExtensionError, ExtensionHttpHandler, ExtensionHttpMethod, ExtensionHttpResponse,
    ExtensionHttpRoute, HttpContext,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    RuntimeHolder,
    board::{BoardStoreError, Card, CardColumn, now_rfc3339, parse_day},
    directory::{self, DirectoryError},
};

pub const ROUTE_BOARD: &str = "/board";
pub const ROUTE_CARDS: &str = "/cards";
pub const ROUTE_CARD: &str = "/cards/{cardId}";
pub const ROUTE_DIRECTORIES: &str = "/directories";

pub fn routes() -> Vec<ExtensionHttpRoute> {
    vec![
        ExtensionHttpRoute::authenticated(ExtensionHttpMethod::Get, ROUTE_BOARD)
            .description("读取全部看板卡片"),
        ExtensionHttpRoute::authenticated(ExtensionHttpMethod::Post, ROUTE_CARDS)
            .description("新建看板卡片"),
        ExtensionHttpRoute::authenticated(ExtensionHttpMethod::Patch, ROUTE_CARD)
            .description("更新看板卡片"),
        ExtensionHttpRoute::authenticated(ExtensionHttpMethod::Delete, ROUTE_CARD)
            .description("删除看板卡片"),
        ExtensionHttpRoute::authenticated(ExtensionHttpMethod::Post, ROUTE_DIRECTORIES)
            .description("列举本机目录，供看板的文件夹选择器使用"),
    ]
}

/// 卡片列的线缆取值。
///
/// 与内部 [`CardColumn`] 分开定义：线缆契约不能随内部枚举重构而改变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardColumnDto {
    Backlog,
    Ready,
    Analyzing,
    Implementing,
    Done,
    Blocked,
}

impl CardColumnDto {
    fn from_column(column: CardColumn) -> Self {
        match column {
            CardColumn::Backlog => Self::Backlog,
            CardColumn::Ready => Self::Ready,
            CardColumn::Analyzing => Self::Analyzing,
            CardColumn::Implementing => Self::Implementing,
            CardColumn::Done => Self::Done,
            CardColumn::Blocked => Self::Blocked,
        }
    }

    /// 用户可写入的列；运行中列由自动化独占，返回 `None`。
    fn into_user_column(self) -> Option<CardColumn> {
        match self {
            Self::Backlog => Some(CardColumn::Backlog),
            Self::Ready => Some(CardColumn::Ready),
            Self::Done => Some(CardColumn::Done),
            Self::Blocked => Some(CardColumn::Blocked),
            Self::Analyzing | Self::Implementing => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDto {
    pub id: String,
    pub title: String,
    pub body: String,
    pub column: CardColumnDto,
    pub working_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 卡片在日历上的归属日；空串表示归属日未知（旧数据），前端归入「未排期」。
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&Card> for CardDto {
    fn from(card: &Card) -> Self {
        Self {
            id: card.id.clone(),
            title: card.title.clone(),
            body: card.body.clone(),
            column: CardColumnDto::from_column(card.column),
            working_dir: card.working_dir.clone(),
            session_id: card.session_id.clone(),
            attempt: card.attempt,
            note: card.note.clone(),
            date: card.date.clone(),
            created_at: card.created_at.clone(),
            updated_at: card.updated_at.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateCardRequest {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    column: Option<CardColumnDto>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateCardRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    column: Option<CardColumnDto>,
    #[serde(default)]
    working_dir: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

/// 文件夹选择器的请求体。
///
/// 路径走 body 而不是 query：绝对路径里可能有空格与非 ASCII 字符，走 query 就得在前端
/// 编码、在扩展里解码，而扩展没有 URL 解码依赖。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListDirectoriesRequest {
    /// 要列举的目录；空串表示从服务端进程的当前目录开始。
    #[serde(default)]
    path: String,
}

pub struct KanbanHttpHandler {
    runtime: RuntimeHolder,
}

impl KanbanHttpHandler {
    pub fn new(runtime: RuntimeHolder) -> Self {
        Self { runtime }
    }
}

#[async_trait::async_trait]
impl ExtensionHttpHandler for KanbanHttpHandler {
    async fn handle(&self, ctx: HttpContext) -> Result<ExtensionHttpResponse, ExtensionError> {
        // 目录列举只看文件系统、不碰看板状态，因此排在运行期守卫之前：
        // 看板数据不可用时，文件夹选择器没有理由跟着一起失效。
        if ctx.route().path == ROUTE_DIRECTORIES {
            return list_directories_response(&ctx);
        }

        let Some(runtime) = self.runtime.lock().clone() else {
            return Ok(unavailable());
        };

        match ctx.route().path.as_str() {
            ROUTE_BOARD => {
                let cards = runtime
                    .store()
                    .read(|board| board.cards.iter().map(CardDto::from).collect::<Vec<_>>())
                    .map_err(internal)?;
                Ok(ExtensionHttpResponse::json(200, json!({ "cards": cards })))
            },
            ROUTE_CARDS => {
                let request: CreateCardRequest = ctx.json()?;
                let column = request.column.unwrap_or(CardColumnDto::Backlog);
                let Some(column) = column.into_user_column() else {
                    return Ok(rejected_column());
                };
                let Some(working_dir) = request
                    .working_dir
                    .or_else(|| runtime.config().default_working_dir.clone())
                else {
                    return Ok(ExtensionHttpResponse::error(
                        400,
                        "invalid_input",
                        "未指定工作目录，且扩展配置中没有 defaultWorkingDir",
                    ));
                };
                let date = resolve_day(request.date.as_deref())?;
                let mut card = Card::new(request.title, request.body, working_dir, column);
                if let Some(date) = date {
                    card.date = date;
                }
                let created = card.clone();
                runtime
                    .store()
                    .mutate(move |board| {
                        board.cards.push(created);
                        Ok(())
                    })
                    .map_err(internal)?;
                Ok(ExtensionHttpResponse::json(
                    200,
                    serde_json::to_value(CardDto::from(&card)).map_err(internal)?,
                ))
            },
            ROUTE_CARD => {
                let Some(card_id) = ctx.request().path_params.get("cardId").cloned() else {
                    return Ok(ExtensionHttpResponse::error(
                        400,
                        "invalid_input",
                        "缺少卡片 id",
                    ));
                };
                match ctx.request().method {
                    ExtensionHttpMethod::Delete => {
                        runtime
                            .store()
                            .mutate(|board| {
                                let before = board.cards.len();
                                board.cards.retain(|card| card.id != card_id);
                                if board.cards.len() == before {
                                    return Err(BoardStoreError::CardNotFound(card_id.clone()));
                                }
                                Ok(())
                            })
                            .map_err(bad_request)?;
                        Ok(ExtensionHttpResponse::json(
                            200,
                            json!({ "deleted": card_id }),
                        ))
                    },
                    ExtensionHttpMethod::Patch => {
                        let request: UpdateCardRequest = ctx.json()?;
                        let date = resolve_day(request.date.as_deref())?;
                        let column = match request.column {
                            Some(column) => match column.into_user_column() {
                                Some(column) => Some(column),
                                None => return Ok(rejected_column()),
                            },
                            None => None,
                        };
                        let updated = runtime
                            .store()
                            .mutate(|board| {
                                let Some(card) =
                                    board.cards.iter_mut().find(|card| card.id == card_id)
                                else {
                                    return Err(BoardStoreError::CardNotFound(card_id.clone()));
                                };
                                if card.column.is_running() {
                                    return Err(BoardStoreError::CardRunning {
                                        card_id: card_id.clone(),
                                    });
                                }
                                if let Some(title) = &request.title {
                                    card.title = title.clone();
                                }
                                if let Some(body) = &request.body {
                                    card.body = body.clone();
                                }
                                if let Some(working_dir) = &request.working_dir {
                                    card.working_dir = working_dir.clone();
                                }
                                if let Some(date) = &date {
                                    card.date = date.clone();
                                }
                                if let Some(column) = column {
                                    card.column = column;
                                }
                                card.updated_at = now_rfc3339();
                                Ok(card.clone())
                            })
                            .map_err(bad_request)?;
                        Ok(ExtensionHttpResponse::json(
                            200,
                            serde_json::to_value(CardDto::from(&updated)).map_err(internal)?,
                        ))
                    },
                    _ => Ok(not_found()),
                }
            },
            _ => Ok(not_found()),
        }
    }
}

/// 列举一层子目录。
///
/// 路径本身的问题（不存在、指向文件、不是绝对路径）是用户输入错误，返回 400 与可读消息，
/// 让选择器把消息显示在弹窗里；真正的 IO 故障才是 500。
fn list_directories_response(ctx: &HttpContext) -> Result<ExtensionHttpResponse, ExtensionError> {
    let request: ListDirectoriesRequest = ctx.json()?;
    Ok(match directory::list_directories(&request.path) {
        Ok(listing) => {
            ExtensionHttpResponse::json(200, serde_json::to_value(listing).map_err(internal)?)
        },
        Err(DirectoryError::Io(error)) => {
            ExtensionHttpResponse::error(500, "internal", error.to_string())
        },
        Err(error) => ExtensionHttpResponse::error(400, "invalid_input", error.to_string()),
    })
}

fn unavailable() -> ExtensionHttpResponse {
    ExtensionHttpResponse::error(503, "kanban_unavailable", "看板扩展尚未启动")
}

fn rejected_column() -> ExtensionHttpResponse {
    ExtensionHttpResponse::error(400, "invalid_input", "运行中的列由自动化独占，不能直接写入")
}

fn not_found() -> ExtensionHttpResponse {
    ExtensionHttpResponse::error(404, "not_found", "未知的看板路由")
}

/// 校验并归一化请求里的归属日。
///
/// 缺省时返回 `None`：新建走 [`Card::new`] 的创建当天，更新保持原值不动。
fn resolve_day(value: Option<&str>) -> Result<Option<String>, ExtensionError> {
    value.map(parse_day).transpose().map_err(bad_request)
}

fn bad_request(error: BoardStoreError) -> ExtensionError {
    ExtensionError::InvalidInput {
        code: astrcode_extension_sdk::WireErrorCode::InvalidInput
            .as_str()
            .into(),
        message: error.to_string(),
        hint: None,
    }
}

fn internal(error: impl std::fmt::Display) -> ExtensionError {
    ExtensionError::Internal(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use astrcode_extension_sdk::{extension::ExtensionHttpRequest, testing::HttpContextBuilder};

    use super::*;

    /// 目录列举不碰看板状态，因此用空运行期句柄就能验证整条路由。
    fn handler_without_runtime() -> KanbanHttpHandler {
        KanbanHttpHandler::new(Arc::new(parking_lot::Mutex::new(None)))
    }

    fn directories_route() -> ExtensionHttpRoute {
        routes()
            .into_iter()
            .find(|route| route.path == ROUTE_DIRECTORIES)
            .expect("directories 路由必须注册")
    }

    async fn call_directories(path: &str) -> ExtensionHttpResponse {
        let request = ExtensionHttpRequest::new(ExtensionHttpMethod::Post, ROUTE_DIRECTORIES)
            .json_body(json!({ "path": path }));
        handler_without_runtime()
            .handle(
                HttpContextBuilder::new(crate::EXTENSION_ID, directories_route(), request).build(),
            )
            .await
            .expect("handler must not fail")
    }

    #[tokio::test]
    async fn directories_route_lists_subdirectories() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("alpha")).unwrap();
        std::fs::write(root.path().join("note.txt"), b"x").unwrap();

        let response = call_directories(&root.path().to_string_lossy()).await;

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["path"],
            root.path().to_string_lossy().as_ref()
        );
        assert_eq!(response.body["entries"].as_array().unwrap().len(), 1);
        assert_eq!(response.body["entries"][0]["name"], "alpha");
    }

    #[tokio::test]
    async fn directories_route_reports_bad_paths_as_client_errors() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");

        let response = call_directories(&missing.to_string_lossy()).await;

        assert_eq!(response.status, 400);
        assert_eq!(response.body["error"]["code"], "invalid_input");
    }

    #[test]
    fn running_columns_are_not_user_writable() {
        assert!(CardColumnDto::Analyzing.into_user_column().is_none());
        assert!(CardColumnDto::Implementing.into_user_column().is_none());
        for column in [
            CardColumnDto::Backlog,
            CardColumnDto::Ready,
            CardColumnDto::Done,
            CardColumnDto::Blocked,
        ] {
            assert!(column.into_user_column().is_some(), "{column:?}");
        }
    }

    #[test]
    fn card_dto_round_trips_every_column() {
        for column in [
            CardColumn::Backlog,
            CardColumn::Ready,
            CardColumn::Analyzing,
            CardColumn::Implementing,
            CardColumn::Done,
            CardColumn::Blocked,
        ] {
            let mut card = Card::new("t".into(), "b".into(), "/tmp".into(), column);
            card.note = Some("note".into());
            let dto = CardDto::from(&card);
            assert_eq!(
                dto.column.into_user_column().is_some(),
                !column.is_running()
            );
            assert_eq!(dto.id, card.id);
        }
    }

    #[test]
    fn create_request_rejects_unknown_fields() {
        serde_json::from_value::<CreateCardRequest>(json!({
            "title": "t",
            "unexpected": true
        }))
        .expect_err("unknown fields must be rejected");
    }
    #[test]
    fn resolve_day_normalizes_and_rejects_bad_days() {
        assert_eq!(resolve_day(None).unwrap(), None);
        assert_eq!(
            resolve_day(Some("2026-3-7")).unwrap().as_deref(),
            Some("2026-03-07")
        );
        assert!(resolve_day(Some("2026-13-01")).is_err());
        assert!(resolve_day(Some("")).is_err());
    }

    #[test]
    fn update_request_accepts_date_and_still_rejects_unknown_fields() {
        serde_json::from_value::<UpdateCardRequest>(json!({ "date": "2026-03-07" }))
            .expect("date 必须被接受");
        serde_json::from_value::<UpdateCardRequest>(json!({ "unexpected": true }))
            .expect_err("unknown fields must be rejected");
    }

    #[test]
    fn list_directories_request_defaults_and_rejects_unknown_fields() {
        let request: ListDirectoriesRequest =
            serde_json::from_value(json!({})).expect("path 必须可选");
        assert_eq!(request.path, "");
        serde_json::from_value::<ListDirectoriesRequest>(json!({ "unexpected": true }))
            .expect_err("unknown fields must be rejected");
    }
}
