//! `/ralph` 命令面。
//!
//! 子命令刻意只留最小集：`start` / `stop` / `status` / `cancel`。任务正文写在
//! `.ralph/<name>.md`，不塞进命令行——那样才能用编辑器改。

use astrcode_extension_sdk::{
    WireErrorCode,
    extension::{
        CommandContext, CommandHandler, ExtensionCall, ExtensionCommandResult, ExtensionError,
    },
    wire::host::{HostWorkspaceReadOutput, HostWorkspaceReadRequest, HostWorkspaceWriteRequest},
};

use crate::{
    plan::{IDLE_STOP, NO_PROGRESS_STOP},
    prompt,
    state::{LoopState, LoopStatus, LoopStore, loops_dir_from_base},
};

/// 默认迭代上限，对齐上游 pi 插件。
pub(crate) const DEFAULT_MAX_ITERATIONS: u32 = 50;

/// 任务文件所在目录，相对工作区。
const TASK_DIR: &str = ".ralph";

const PREFIX: &str = "Ralph 循环：";

/// 名字同时是任务文件名与状态文件名，必须挡住路径穿越。
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("缺少循环名。用法：`/ralph start <name>`。".into());
    }
    if name.chars().count() > 64 {
        return Err("循环名过长（上限 64 字符）。".into());
    }
    if name == "." || name == ".." {
        return Err("循环名不能是 `.` 或 `..`。".into());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err("循环名不能包含路径分隔符或控制字符。".into());
    }
    Ok(())
}

fn task_file_path(name: &str) -> String {
    format!("{TASK_DIR}/{name}.md")
}

fn split_once_whitespace(value: &str) -> (&str, &str) {
    match value.find(char::is_whitespace) {
        Some(index) => (&value[..index], value[index..].trim_start()),
        None => (value, ""),
    }
}

struct StartArgs {
    name: String,
    max_iterations: Option<u32>,
    completion_promise: Option<String>,
}

fn parse_start_args(raw: &str) -> Result<StartArgs, String> {
    let mut tokens = raw.split_whitespace();
    let name = tokens.next().unwrap_or_default().to_owned();
    let mut max_iterations = None;
    let mut completion_promise = None;

    while let Some(token) = tokens.next() {
        match token {
            "--max" => {
                let value = tokens.next().ok_or("`--max` 缺少数值。")?;
                let parsed = value
                    .parse::<u32>()
                    .map_err(|_| format!("`--max {value}` 不是非负整数（0 表示无限）。"))?;
                max_iterations = Some(parsed);
            },
            "--promise" => {
                let value = tokens.next().ok_or("`--promise` 缺少文本。")?;
                let promise = strip_quotes(value);
                if promise.is_empty() {
                    return Err("`--promise` 不能为空。".into());
                }
                completion_promise = Some(promise.to_owned());
            },
            other => return Err(format!("未知参数 `{other}`。")),
        }
    }

    Ok(StartArgs {
        name,
        max_iterations,
        completion_promise,
    })
}

/// 去掉一层成对引号：`--promise "DONE"` 与 `--promise DONE` 应当等价。
fn strip_quotes(value: &str) -> &str {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].trim();
        }
    }
    trimmed
}

fn store_for(call: &impl ExtensionCall) -> Result<LoopStore, ExtensionError> {
    let base = call.paths().require_session_data_dir()?;
    Ok(LoopStore::new(loops_dir_from_base(base)))
}

fn display(content: impl Into<String>, is_error: bool) -> ExtensionCommandResult {
    ExtensionCommandResult::display(content, is_error)
}

pub(crate) struct RalphCommandHandler;

#[async_trait::async_trait]
impl CommandHandler for RalphCommandHandler {
    async fn execute(&self, ctx: CommandContext) -> Result<ExtensionCommandResult, ExtensionError> {
        let store = store_for(&ctx)?;
        let (head, tail) = split_once_whitespace(ctx.argument().trim());
        Ok(match head.to_ascii_lowercase().as_str() {
            "" | "status" => status(&store),
            "start" => start(&store, &ctx, tail).await,
            "stop" => stop(&store),
            "cancel" => cancel(&store, tail),
            other => display(
                format!("{PREFIX}未知子命令 `{other}`。\n\n{}", render_help()),
                true,
            ),
        })
    }
}

/// `/ralph start <name> [--max N] [--promise TEXT]`。
async fn start(store: &LoopStore, ctx: &CommandContext, raw: &str) -> ExtensionCommandResult {
    let args = match parse_start_args(raw) {
        Ok(args) => args,
        Err(message) => return display(format!("{PREFIX}{message}\n\n{}", render_help()), true),
    };
    if let Err(message) = validate_name(&args.name) {
        return display(format!("{PREFIX}{message}"), true);
    }
    match store.load_current() {
        Ok(Some(current)) if current.status.allows_advance() => {
            return display(
                format!(
                    "{PREFIX}本会话已有进行中的循环 `{}`。先 `/ralph cancel {}` 再启动新的。",
                    current.name, current.name
                ),
                true,
            );
        },
        Ok(_) => {},
        Err(error) => return display(format!("{PREFIX}{error}"), true),
    }

    let task_file = task_file_path(&args.name);
    let created = match ensure_task_file(ctx, &args.name, &task_file).await {
        Ok(created) => created,
        Err(message) => return display(format!("{PREFIX}{message}"), true),
    };

    let resumed = match store.load(&args.name) {
        Ok(Some(existing)) if existing.status == LoopStatus::Paused => Some(existing),
        Ok(_) => None,
        Err(error) => return display(format!("{PREFIX}{error}"), true),
    };

    let mut state = match resumed {
        Some(mut existing) => {
            existing.set_status(LoopStatus::Active, None);
            existing.reset_breakers();
            if let Some(max) = args.max_iterations {
                existing.max_iterations = max;
            }
            if let Some(promise) = args.completion_promise {
                existing.completion_promise = Some(promise);
            }
            existing
        },
        None => LoopState::new(
            args.name.clone(),
            task_file.clone(),
            args.max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS),
            args.completion_promise,
        ),
    };
    // 任务文件路径以本次解析为准：名字没变，但状态文件可能来自旧版本。
    state.task_file = task_file.clone();
    state.touch();

    if let Err(error) = store.save(&state) {
        return display(format!("{PREFIX}{error}"), true);
    }

    let budget = if state.max_iterations == 0 {
        "无上限".to_owned()
    } else {
        state.max_iterations.to_string()
    };
    let promise = state
        .completion_promise
        .as_deref()
        .unwrap_or("（未配置：只会因上限或熔断停下）");
    let action = if state.iteration > 0 {
        "恢复"
    } else {
        "启动"
    };
    let created_note = if created {
        "（已写入模板，请先编辑）"
    } else {
        ""
    };
    display(
        format!(
            "{PREFIX}{action}循环 `{}`，从第 {} \
             轮接着跑。\n任务文件：{task_file}{created_note}\n迭代上限：{budget}｜完成承诺：\
             {promise}\n模型每次自然停下后会自动注入任务文件全文，直到命中完成承诺或上限。\n提示：\
             `{TASK_DIR}/` 是工作区产物，建议加进 `.gitignore`。",
            state.name, state.iteration
        ),
        false,
    )
}

/// 确保任务文件存在且可读，返回是否刚刚创建了模板。
///
/// 只有「宿主报 I/O 错误」才当作文件不存在并写入模板；其它错误码（文件过大、权限等）
/// 一律拒绝启动——任务文件是人的产物，宁可让用户手工处理，也不能覆盖掉。
async fn ensure_task_file(
    ctx: &CommandContext,
    name: &str,
    task_file: &str,
) -> Result<bool, String> {
    let workspace = ctx
        .host()
        .workspace()
        .map_err(|error| format!("打开工作区失败：{error}"))?;
    match workspace
        .read(HostWorkspaceReadRequest::new(task_file))
        .await
    {
        Ok(HostWorkspaceReadOutput::Text { content, .. }) => {
            if content.trim().is_empty() {
                return Err(format!(
                    "任务文件 {task_file} 是空的。请先把目标与清单写进去：\n\n{}",
                    prompt::task_file_template(name)
                ));
            }
            Ok(false)
        },
        Ok(_) => Err(format!("{task_file} 不是文本文件。")),
        Err(error) if error.code_enum() == Some(WireErrorCode::IoError) => {
            workspace
                .write(HostWorkspaceWriteRequest {
                    path: task_file.to_owned(),
                    content: prompt::task_file_template(name),
                    create_dirs: true,
                })
                .await
                .map_err(|error| format!("写入任务文件模板失败：{error}"))?;
            Ok(true)
        },
        Err(error) => Err(format!("读取 {task_file} 失败：{error}")),
    }
}

/// `/ralph stop`：暂停当前循环。
fn stop(store: &LoopStore) -> ExtensionCommandResult {
    let mut state = match store.load_current() {
        Ok(Some(state)) => state,
        Ok(None) => return display(format!("{PREFIX}本会话没有循环。"), false),
        Err(error) => return display(format!("{PREFIX}{error}"), true),
    };
    if !state.status.allows_advance() {
        return display(
            format!(
                "{PREFIX}循环 `{}` 已经是{}，无需停止。",
                state.name,
                state.status.label()
            ),
            false,
        );
    }
    state.set_status(LoopStatus::Paused, None);
    match store.save(&state) {
        Ok(()) => display(
            format!(
                "{PREFIX}已暂停循环 `{}`（停在第 {} 轮）。同名 `/ralph start {}` 可以接着跑。",
                state.name, state.iteration, state.name
            ),
            false,
        ),
        Err(error) => display(format!("{PREFIX}{error}"), true),
    }
}

/// `/ralph cancel <name>`：结束循环并删除状态文件；任务文件保留。
fn cancel(store: &LoopStore, raw: &str) -> ExtensionCommandResult {
    let (name, rest) = split_once_whitespace(raw);
    if !rest.is_empty() {
        return display(format!("{PREFIX}`cancel` 只接受一个循环名。"), true);
    }
    if let Err(message) = validate_name(name) {
        return display(
            format!("{PREFIX}{message}用法：`/ralph cancel <name>`。"),
            true,
        );
    }
    let task_file = match store.load(name) {
        Ok(Some(state)) => state.task_file,
        Ok(None) => return display(format!("{PREFIX}没有名为 `{name}` 的循环。"), true),
        Err(error) => return display(format!("{PREFIX}{error}"), true),
    };
    match store.remove(name) {
        Ok(()) => display(
            format!("{PREFIX}已结束循环 `{name}`。任务文件 {task_file} 保留，可自行删除。"),
            false,
        ),
        Err(error) => display(format!("{PREFIX}{error}"), true),
    }
}

/// `/ralph status`。
fn status(store: &LoopStore) -> ExtensionCommandResult {
    let state = match store.load_current() {
        Ok(Some(state)) => state,
        Ok(None) => {
            return display(
                format!(
                    "{PREFIX}本会话没有循环。`/ralph start <name>` 开始一个。\n\n{}",
                    render_help()
                ),
                false,
            );
        },
        Err(error) => return display(format!("{PREFIX}{error}"), true),
    };

    let budget = if state.max_iterations == 0 {
        format!("{}（无上限）", state.iteration)
    } else {
        format!("{}/{}", state.iteration, state.max_iterations)
    };
    let promise = state.completion_promise.as_deref().unwrap_or("（未配置）");
    let stop_reason = state
        .stop_reason
        .map_or_else(|| "无".to_owned(), |reason| reason.text().to_owned());

    display(
        format!(
            "{PREFIX}循环 `{}` \
             {}\n轮次：{budget}｜完成承诺：{promise}\n任务文件：{}\n熔断链：空转 {}（阈值 \
             {}）｜复读 {}（阈值 {}）\n最近停止原因：{stop_reason}\n\n本会话续跑优先级：看板(60) \
             > Ralph(50) > goal(40) > sleep-continue(0)。\n看板在驱动本会话时 Ralph 不介入；Ralph \
             进行中时 sleep-continue 不会生效。",
            state.name,
            state.status.label(),
            state.task_file,
            state.idle_streak,
            IDLE_STOP,
            state.no_progress_streak,
            NO_PROGRESS_STOP,
        ),
        false,
    )
}

fn render_help() -> String {
    "Ralph 循环用法：\n\
     \x20 /ralph start <name> [--max N] [--promise TEXT]  启动或恢复（--max 0 表示无限）\n\
     \x20 /ralph stop                                     暂停当前循环\n\
     \x20 /ralph status                                   查看状态\n\
     \x20 /ralph cancel <name>                            结束并删除状态（任务文件保留）\n\
     \n\
     任务正文写在 `.ralph/<name>.md`：每轮把它的全文注入模型，模型负责回写进度。"
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation_blocks_path_traversal() {
        assert!(validate_name("fix-tests").is_ok());
        assert!(validate_name("修测试").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name(".").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("../escape").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
    }

    #[test]
    fn start_args_parse_flags_and_quotes() {
        let args = parse_start_args("fix-tests --max 7 --promise \"DONE\"").unwrap();
        assert_eq!(args.name, "fix-tests");
        assert_eq!(args.max_iterations, Some(7));
        assert_eq!(args.completion_promise.as_deref(), Some("DONE"));

        let bare = parse_start_args("x").unwrap();
        assert_eq!(bare.max_iterations, None);
        assert_eq!(bare.completion_promise, None);

        let unbounded = parse_start_args("x --max 0").unwrap();
        assert_eq!(unbounded.max_iterations, Some(0));
    }

    #[test]
    fn start_args_reject_unknown_flags_and_bad_values() {
        assert!(parse_start_args("x --max").is_err());
        assert!(parse_start_args("x --max nope").is_err());
        assert!(parse_start_args("x --promise").is_err());
        assert!(parse_start_args("x --promise \"\"").is_err());
        assert!(parse_start_args("x --wat").is_err());
    }

    #[test]
    fn task_file_lives_under_the_workspace_ralph_dir() {
        assert_eq!(task_file_path("fix-tests"), ".ralph/fix-tests.md");
    }
}
