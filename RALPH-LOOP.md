# Ralph Loop（拉尔夫循环）调研与移植方案

> 状态：调研与决策完成；实施方案见 §6，待开工
> 调研日期：2026-10（上游代码为当日 main 分支）
> 关联：`docs/extension-hook-matrix.md`、`docs/kanban-extension-design.md`、`crates/astrcode-extension-sdk`、`astrcodey-extensions/crates/astrcode-ext-sleep-continue`

---

## 0. 一句话结论

Ralph Loop 的本质不是「一个新机制」，而是**在 agent 自然停下时拒绝结束、把同一份任务提示原样再喂一遍**，
直到出现终止信号。三家上游实现（Claude Code / pi 插件 / omp）的差别只在**终止条件**与**注入通道**，
共同点是一条清晰的判据链：`终止信号 → 预算 → 熔断 → 注入 → 再来一轮`。

AstrCode 宿主**已经有承载它的全部原语**：`continue_after_stop` 决策钩子 + `session_control.defer_context` 注入 +
`session_data_dir` 持久化。因此移植的正确形态不是改宿主，而是**新增一个只依赖插件系统的扩展**。

---

## 1. 上游实现事实梳理

### 1.1 Claude Code：`ralph-wiggum` 官方插件

来源：`anthropics/claude-code` 仓库 `plugins/ralph-wiggum/`（`.claude-plugin/marketplace.json` 中列出，
作者 Daisy Hollman）。

**机制**：用 **Stop hook 拦截会话退出**。

- 状态文件 `.claude/ralph-loop.local.md`，YAML frontmatter + 正文即 prompt：

  ```yaml
  ---
  active: true
  iteration: 1
  max_iterations: 0        # 0 = 无限
  completion_promise: "DONE"
  started_at: "..."
  ---
  <prompt 正文>
  ```

- `hooks/stop-hook.sh` 每次会话要退出时被调用（`hooks.json` 注册在 `Stop` 事件）：

  1. 状态文件不存在 → `exit 0`（放行退出）。
  2. 校验 `iteration` / `max_iterations` 是数字，否则**删状态文件并放行**（把损坏转成显式停止，不静默续跑）。
  3. `iteration >= max_iterations`（且 max > 0）→ 删状态文件、放行。
  4. 从 `transcript_path` 取**最后一条 assistant 消息**的 text 部分。
  5. 若设了 `completion_promise`，用 Perl 从 text 里抓**第一个** `<promise>...</promise>`，
     与承诺字符串做**字面量**比较（`=` 而非 `==`，避免 glob 元字符误匹配）。命中 → 删状态文件、放行。
  6. 否则 `iteration += 1` 原子写回，输出 JSON 阻断退出：

     ```json
     { "decision": "block", "reason": "<原样 prompt 正文>", "systemMessage": "🔄 Ralph iteration N | ..." }
     ```

- 命令面：`/ralph-loop "<prompt>" --max-iterations N --completion-promise "TEXT"`、`/cancel-ralph`。
- 设计取舍（README 明说）：**prompt 每轮不变**，靠「文件系统 + git 历史」承载进度；
  进度可见性来自「模型能看到自己上一轮改过的文件」。
- 安全阀：`--max-iterations`。README 明确警告 `--completion-promise` 是**精确串匹配**，
  不能表达多终点（"SUCCESS" vs "BLOCKED"），所以**唯一可靠的安全阀是迭代上限**。

**关键判据**：终止 = 迭代上限 OR `<promise>` 精确匹配。注入 = 原样 prompt。计数与状态在**文件**里。

### 1.2 pi 插件：`@tmustier/pi-ralph-wiggum`

来源：npm `@tmustier/pi-ralph-wiggum@0.2.4`（`tmustier/pi-extensions`，MIT），是 Claude Code 插件到 pi 的移植。

**机制**：**不拦截退出，而是把「下一轮」当作 followUp 消息排队**。

- 状态文件 `.ralph/<name>.state.json`（`LoopState`）：`name / taskFile / iteration / maxIterations /
  itemsPerIteration / reflectEvery / reflectInstructions / status(active|paused|completed) /
  startedAt / completedAt / ownerSessionId`。
- 任务文件 `.ralph/<name>.md`：Markdown 模板（Goals / Checklist / Verification / Final Verification / Notes）。
- 每轮 prompt = 头部横幅 + （反射指令）+ 任务文件全文 + **Completion Gate** + **Stale Prompt Guard** + 指令。

  三个 prompt 片段值得单独记下，它们是「防自欺」的设计：

  | 片段 | 作用 |
  |---|---|
  | Completion Gate | 不能只凭 checklist 打勾就宣布完成：必须跑一条**外部监视者可重跑**的最终验证命令，并把命令、工作目录、环境变量、产物路径写进任务文件 |
  | Stale Prompt Guard | 每轮开工前重读 state 文件，若 `status == completed` 则**拒绝干活**（防旧 prompt 复活） |
  | Reflection Checkpoint | 每 N 轮插入一段自省指令（做到哪了 / 卡在哪 / 下一步优先级） |

- 驱动方式：**agent 自己调 `ralph_done` 工具**推进下一轮（`pi.sendUserMessage(..., {deliverAs: "followUp"})`）。
  `agent_end` 里**不自动续跑**——注释写明「让用户的 stop 消息先被处理」。
- 终止：`agent_end` 里检查最后一条 assistant 消息是否 `includes("<promise>COMPLETE</promise>")`，
  或 `iteration >= maxIterations`（默认 **50**）。命中即 `status = completed` 并投递结束横幅。
- `ownerSessionId`：**只有拥有该 loop 的会话才会注入**；别的会话必须 `/ralph resume <name>` 才接管。
  防止多会话下两个进程同时往一个 loop 里塞 prompt。
- 命令面：`/ralph start|stop|resume|status|cancel|archive|clean|list|nuke`、`/ralph-stop`。
- 工具面：`ralph_start`（agent 可自启 loop）、`ralph_done`（推进一轮）。
- 交互约定：**Esc 暂停**、发消息即恢复、空闲时 `/ralph-stop` 停止。

**关键判据**：终止 = 上限 OR `<promise>` 子串匹配；推进由**工具调用**触发（agent 主动），不是 hook 强推。

### 1.3 pi 插件：`sleep-continue`（AstrCode 已有对应移植）

来源：`cirno99/pi-backup` 的 `agent/extensions/sleep-continue/src/index.ts`。
AstrCode 侧已移植为 `astrcodey-extensions/crates/astrcode-ext-sleep-continue`。

**机制**：`agent_settled` 后自动注入一条用户消息（默认「继续」）。

- 状态在**进程内存**（上游）→ AstrCode 移植版改为**落盘**（`extension_data/astrcode-sleep-continue/config.json`），
  理由：无人值守时扩展进程会被宿主重载，内存态会在最需要时消失。
- 终止判据（AstrCode 版 `plan::decide`，顺序即优先级）：
  1. `no_progress_stop`：连续 N 轮「没有新内容」（无工具调用且回复重复或为空）→ 停（默认 **1**）
  2. `idle_stop`：连续 N 轮「没有工具调用」→ 停（默认 **3**）
  3. `max`：单次人工 turn 续跑次数到顶（默认 **100**）
- 续跑文本分两种：干过活 → `continue_text`（默认「继续」）；没干活 → `nudge_text`（纠正提示）。
- 附带：`pre_tool_use` 拦截提问类工具按推荐项自动作答、`turn_end` 失败重试、`UserPromptSubmit` 重置预算。
- **预算语义是「单次人工 turn 的预算」**：人插一句话就重新给满。

**关键判据**：终止 = 复读熔断 → 空转熔断 → 次数上限。**没有完成承诺**，它不知道任务做没做完，只管「别停」。

### 1.4 omp（oh-my-pi）：`/loop` 命令

来源：`can1357/oh-my-pi` 的 `packages/coding-agent/src/modes/{loop-limit,loop-condition}.ts` +
`interactive-mode.ts` 的 `#runLoopIteration` / `#passesLoopCondition`。

**机制**：交互层在「空闲」时自动重投同一 prompt，**条件用外部命令的退出码判定**。

- 用法：`/loop [count|duration] [--while|--until '<command>'] [prompt]`
  - 预算：`10`（次数）/ `10m`、`1h30m`（时长）
  - 条件：`--while '<cmd>'`（命令成功则继续）/ `--until '<cmd>'`（命令失败则继续）
  - 无参数 → 无预算无条件的无限循环（保持旧行为）
- 条件判定（`loop-condition.ts`，注释写得非常明确）：
  - **退出码 0 权威，stdout 忽略**（`echo false` 退出 0，所以「看起来像布尔」的输出与退出码会打架）。
  - `--while` + exit 0 → 继续；`--until` + exit 0 → 停（条件已满足）。
  - **exit 1 是唯一的「条件为假」**；exit >1（127 命令不存在 / 126 不可执行 / 2 语法错）→ 判定为
    **条件本身坏了**，报错停止，而不是读成「假」。理由写在注释里：打错字的条件会让循环停下来，
    看起来和「干完了」一模一样——正是这个特性要避免的失败模式。
  - 超时 → 报错停止；用户 Esc → `aborted`（由调用方处理，不算错）。
  - 条件命令跑在**独立 shell 会话**（`sessionKey = loop-condition:<sessionId>`），
    防止 `cd` 污染 agent 自己的持久 shell。
- 驱动（`interactive-mode.ts`）：
  - 每轮前 **800ms 延迟**，给用户按 Esc 的机会。
  - 门禁顺序（注释解释得很清楚）：**预算耗尽 → 条件 → 再确认未忙 → 消费预算 → (compact|reset) → 投递**。
    预算检查在条件**之前**（用户的命令不该为一个已经结束的循环再跑一次），
    消费预算在条件**之后**（被条件拦下的轮次不该烧预算）。
  - `#isAutoSubmitBlocked()` = `isStreaming || isCompacting || hasPostPromptWork`；忙就延后重试。
  - 每轮可选 `prompt` / `compact` / `reset` 三种动作（compact/reset 是 omp 特有的上下文管理）。
  - `loopPrompt` 变化即失效（旧轮次的延迟回调不会误投）。

**关键判据**：终止 = 预算（次数或时长）OR 外部命令退出码。**终止条件外置为可执行命令**，这是三家最不同的一家。

### 1.5 三家横向对比

| 维度 | Claude Code `ralph-wiggum` | pi `pi-ralph-wiggum` | pi `sleep-continue` | omp `/loop` |
|---|---|---|---|---|
| 拦截点 | Stop hook（拒绝退出） | 工具调用后 followUp | `agent_settled` | 空闲自动重投 |
| 谁推进 | hook 强制 | **agent 调 `ralph_done`** | hook 强制 | 交互层强制 |
| 每轮 prompt | 原样不变 | 任务文件全文 + 门禁片段 | 固定「继续」/ 纠正提示 | 原样不变 |
| 终止信号 | 迭代上限 / `<promise>` 精确匹配 | 上限(50) / `<promise>COMPLETE</promise>` 子串 | 复读/空转/次数上限 | 次数/时长 / **外部命令退出码** |
| 状态落点 | `.claude/ralph-loop.local.md` | `.ralph/<name>.state.json` | 内存（AstrCode 版落盘） | 进程内存 |
| 进度载体 | 文件 + git 历史 | 任务文件（Checklist/Notes） | 无 | 无 |
| 防自欺设计 | 警告「别撒谎退出」 | Completion Gate + Stale Prompt Guard + Reflection | 复读熔断 | 条件命令必须可判定 |
| 安全阀 | `--max-iterations` | `--max-iterations`（默认 50） | `max`（默认 100） | 预算可选 |

**共性抽象（可移植的部分）**：

```
状态：{ loop_id, iteration, max_iterations, 终止信号配置, 任务文件, owner_session, status }
判据链：终止信号命中 → 预算耗尽 → 熔断(空转/复读) → 注入本轮 prompt → iteration += 1
注入：一条「本轮 prompt」文本，进入下一轮上下文
安全阀：必须有界（上限 or 熔断），因为「完成承诺」是模型自报的，不可信
```

---

## 2. AstrCode 宿主现有能力盘点（移植的地基）

### 2.1 `continue_after_stop` 决策钩子

- 注册：`Registrar::on_continue_after_stop(priority, ContinueAfterStopOptions, handler)`
  （`crates/astrcode-extension-sdk/src/extension/registrar.rs:334`）
- 需要能力 `turn_continuation_control`（`docs/extension-hook-matrix.md`）
- 结果：`ContinueAfterStopResult::{EndTurn, ContinueOneStep}`（`hooks/results.rs:95`）
- 载荷（`hooks/contexts.rs:234`）：`assistant_text()` / `finish_reason()` / `continuations_this_turn()`
  —— **`assistant_text` 直接可用，不需要像 Claude Code 那样去读 transcript**
- 分发：`astrcode-extensions/src/runner/mod.rs:2121`，**按优先级降序，首个 `ContinueOneStep` 生效**；
  每个 handler 的每轮预算由注册时声明的 `options` 单独门禁
- 触发点：`crates/astrcode-session/src/turn_runner.rs:421` → `should_continue_after_stop()`（:1004），
  命中后 `StepOutcome::Continue`，**在同一个 turn 内再跑一个 agent step**，
  `state.record_continue_after_stop()` 递增 `continuations_this_turn`

> **关键差异**：宿主的钩子**只能表达「再跑一个 step」，不能携带文本**。
> 「喂什么话」必须由扩展自己通过 `session_control.defer_context` 注入
> ——`sleep-continue` 就是这么做的（`hook::continue_with` 先 `defer_context(text)`，成功才返回 `ContinueOneStep`）。
> 移植 Ralph Loop 时这条同样成立。

### 2.2 注入通道

- `defer_context`：把输入**追加进当前 turn**，不启动也不排队新 turn
  ——正好对应「同一 turn 内再跑一个 step」。
- `queue_or_start` / `inject_or_start`：`sleep-continue` 的 `turn_end` 重试用前者（turn 正在失败时注入会丢）。
- 两者都需要 `session_control` 能力。

### 2.3 持久化与命令面

- `ctx.paths().session_data_dir()`（按会话 × 扩展命名空间）/ `global_data_dir()`
  ——`astrcode-extension-goal` 与 `astrcode-extension-kanban` 都用它落盘。
- `Registrar::command(SlashCommand, handler)`：`SlashCommand { name, description, args_schema,
  requires_idle, argument_completions, priority, availability, execution }`
  （`registrar.rs:154`；`goal` 扩展有完整用例，`astrcode-extension-goal/src/lib.rs:154`）。
- `Registrar::tool(ExtensionToolDefinition, handler)` + `ToolHandler::plan/execute`。
- 提示词注入：`on_before_provider_request` / `on_provider_contribution`（`goal` 扩展用它注入 goal 上下文）。

### 2.4 现有三个「续跑」相关实现（兼容性对象）

| 实现 | 注册点 | 优先级 | 预算声明 | 判据 |
|---|---|---|---|---|
| `astrcode-extension-kanban` | `on_continue_after_stop` | **60** | `limited(200)` | 卡片处于 `implementing` → 续跑 |
| `astrcode-extension-goal` | `on_continue_after_stop` | **40** | `unlimited()` | goal 活跃且未超预算 → 续跑 |
| `astrcode-ext-sleep-continue`（S5R worker） | `on_continue_after_stop` | worker 默认 | `unlimited()` | 复读/空转/次数熔断 |

**它们已经共存**，靠的是「首个 `ContinueOneStep` 生效」——而且这不是「结果被忽略」，是**提前返回**：
`emit_continue_after_stop` 在 `runner/mod.rs:2145-2151` 一命中 `ContinueOneStep` 就 `return`，
**优先级更低的 handler 这一轮根本不会被调用**。所以：

- 看板会话（priority 60）里，goal（40）与 sleep-continue 的续跑判定**不会执行**；
- 反之，谁的优先级最高，谁就独占该轮的续跑决策权。

这是当前架构下**唯一存在的跨扩展协调杠杆**：扩展之间彼此隔离
（`session.state.read/write` 按 extension_id 命名空间隔离，跨扩展只能走 public HTTP dispatch），
所以「A 扩展感知 B 扩展」在插件系统里没有直接通道，只有**全局优先级排序**。

---

## 3. 兼容性分析（这是本次移植的真正难点）

### 3.1 与看板任务执行流程的关系

看板自动化的事实（`docs/kanban-extension-design.md` §6、`crates/astrcode-extension-kanban/src/lib.rs`）：

1. 轮询领取 `ready` 卡片 → 建 root session（**排除 `askUser`**）→ 投递分析 turn（`wait_for_result`）
2. 置 `implementing` → 投递实施 turn
3. 实施 turn 内靠 `on_continue_after_stop`（priority 60）持续续跑，直到 agent 调 `kanban_update_card` 把卡片
   迁到 `done` / `blocked`
4. `attempt` 约束重投轮次，`maxContinuationsPerTurn`（默认取硬闸门 200）约束单轮续跑

**结论：看板已经在跑一个「隐性 Ralph Loop」**——它就是「不断续跑直到终态信号（工具调用）」。
差别在于：

- 看板的「完成信号」是**结构化工具调用**（`kanban_update_card`），比 `<promise>` 字符串匹配可靠得多；
- 看板**没有**「同一份 prompt 原样重喂」的概念（实施 prompt 只在每次重投时给一次，续跑靠 defer 的空上下文）；
- 看板的续跑**不注入任何文本**——模型只是被要求「继续干」。

因此移植后可能的形态有三种（见 §4），其中**「看板内部升级」与「独立扩展 + 看板协作」是主要候选**。

### 3.2 与 `sleep-continue` 的关系

`sleep-continue` 是**用户级、会话级**的「别停」插件，它的语义与 Ralph Loop **高度重叠但目标不同**：

| | sleep-continue | Ralph Loop |
|---|---|---|
| 目标 | 无人值守时别停 | 把一件任务迭代做完 |
| 终止 | 熔断（复读/空转/次数） | 完成信号 / 上限 |
| prompt | 固定「继续」 | 每轮带任务全文与进度 |

**冲突点不是「文本叠加」，而是「优先级垄断」**：由于高优先级命中即提前返回（§2.4），
**每一轮恰好只有一个 handler 能注入文本**——先跑的那个若返回 `EndTurn` 就轮到下一个，
一旦有人返回 `ContinueOneStep`，后面的 handler 当轮被完全跳过。所以不会出现两条消息叠加。

真正的问题是反过来：**优先级低的一方会静默失效**。

- 若 `sleep-continue` 优先级高于 Ralph：Ralph 的 handler 永远不会被调用，loop 卡死且**无任何提示**
  （`/ralph status` 只会显示 iteration 不动）。
- 若 Ralph 高于 `sleep-continue`：`sleep-continue` 的熔断/重试/提问自动应答**全部失效**，
  用户以为开着的「无人值守」其实没在工作。
- 看板会话里（kanban = 60）同理：Ralph 若低于 60，卡片 `implementing` 期间 Ralph 完全不动。

**必须处理的兼容点**（按重要性）：

1. **优先级与让位规则**：谁在什么条件下该让位，必须显式定死并写进文档；
   否则「静默失效」是最坏的一类 bug（功能看起来开着，其实没跑）。
2. **预算计数不共享**：`continuations_this_turn` 是**全局共享**的同一计数器，
   而 `sleep-continue` 用的是自己落盘的 `continuations`。Ralph 的迭代计数也必须自持
   （落盘），不能依赖 `continuations_this_turn`，否则别的 handler 的续跑会消耗 Ralph 的预算。
3. **跨扩展感知缺通道**：扩展彼此隔离（`session.state.read/write` 按 extension_id 命名空间隔离，
   跨扩展只有 public HTTP dispatch）。所以「Ralph 感知 kanban 卡片状态」或
   「sleep-continue 感知 Ralph 是否活跃」在插件系统里**没有现成通道**，
   要么靠优先级排序，要么需要改对端扩展（跨仓库改动）。

### 3.3 与 `goal` 扩展的关系

`astrcode-extension-goal`（priority 40，`unlimited()`）已经在做「目标驱动的自动续跑」，
并且用 `on_before_provider_request` 注入目标上下文。它与 Ralph Loop 的差异：

- goal 是**单目标 + token 预算**，续跑文本由 `goal_context_message()` 生成，不是「同一份任务文件」；
- goal 的完成由 `update_goal` 工具/状态驱动，没有「完成承诺串」；
- goal 不落任务文件，进度在 `session_data_dir` 的 goal 存储里。

**这是移植前必须先回答的问题：Ralph Loop 与 goal 扩展的边界在哪？**
如果 Ralph 只是「goal + 任务文件 + 完成承诺」，那可能应该在 goal 上扩展而不是新增一个扩展。

---

## 4. 移植方案候选

### 方案 A：新增内置扩展 `astrcode-extension-ralph`（对齐 Claude Code / pi 插件语义）

- 形态：新 crate，只依赖插件系统，注册 `continue_after_stop` + `/ralph` 命令 + `ralph_done` 工具。
- 状态：`session_data_dir`（或 `global_data_dir`，取决于是否跨会话复用）下的
  `<loop>.state.json` + `<loop>.md` 任务文件。
- 每轮：命中「未完成且未到上限」→ `defer_context(build_prompt(...))` → `ContinueOneStep`。
- 终止：`assistant_text` 含 `<promise>X</promise>` 且匹配 → `EndTurn` + 标记 completed；
  或 `iteration >= max_iterations`；或熔断（复用 sleep-continue 的复读/空转判据思路）。
- 优点：语义与上游一一对应，最容易被理解；不动看板。
- 风险：与 `sleep-continue` / `goal` / 看板**三方叠加**，需要明确优先级与互斥策略。

### 方案 B：作为看板自动化的一部分（卡片即任务文件）

- 形态：给 `astrcode-extension-kanban` 增加「卡片带 checklist + 每轮 prompt 携带进度」的能力。
- 优点：不新增扩展；完成信号已是**结构化工具调用**，比 `<promise>` 可靠；无人值守语义已经成立。
- 风险：看板的六列状态机是刻意固定的（设计文档「非目标：不做通用工作流引擎」），
  把 Ralph 的「任务文件 + 反射 + 完成承诺」塞进去会**违反该扩展的设计边界**。

### 方案 C：作为 `sleep-continue` 的「目标模式」（在 astrcodey-extensions 侧扩展）

- 形态：`sleep-continue` 增加「带任务文件与完成承诺的续跑」模式（`/sleep goal <file>` 之类）。
- 优点：**天然解决 3.2 的互斥问题**（同一个插件内不会自己跟自己抢）；复用已有的熔断/重试/落盘设施。
- 风险：sleep-continue 是**用户级插件仓库**（`astrcodey-extensions`），不在 `astrcodez` 内；
  且会把「无人值守」与「任务迭代」两种语义混在一个插件里（该插件 README 明确区分了分层）。

### 方案 D：宿主内置 loop 模式（对齐 omp 的 `/loop`）

- 形态：在 `astrcode-session` / `astrcode-server` 层做 `/loop` 命令 + 条件命令判定。
- 优点：omp 那套「外部命令退出码作为终止条件」是**最可验证**的终止判据，且与模型自报无关。
- 风险：**违反「内置插件只能依赖插件系统」的约束**吗？不违反（它是宿主功能），
  但把循环语义做进宿主会让 `continue_after_stop` 这套扩展钩子出现「第二套并行机制」，
  与既有架构（hook 化）冲突。且需要改 `turn_runner` 的核心控制流，风险最高。

---

## 5. 待决策问题（按依赖顺序）

### 已决策

| # | 问题 | 决定 | 日期 |
|---|---|---|---|
| 1 | 移植形态 | **方案 A**：在 astrcodez 新增内置扩展 `astrcode-extension-ralph`，只依赖插件系统，不动看板与 sleep-continue | 2026-10 |
| 2 | 共存规则 | **纯优先级，Ralph = 50**：kanban(60) 仍优先，看板流程零影响；Ralph 活跃时 sleep-continue(0) 与 goal(40) 静默让位，由 `/ralph status` 显式报告接管事实；不改对端插件 | 2026-10 |
| 3 | 终止判据 | **`<promise>` 精确字面量匹配 + 迭代上限 + 熔断**：取 `assistant_text` 里第一个 `<promise>` 标签做字面量比较；迭代上限与复读/空转熔断兜底 | 2026-10 |
| 4 | 推进方式 | **hook 强制推进**：模型自然停下 → 未命中终止信号则 `defer_context` 注入本轮 prompt 并返回 `ContinueOneStep`；不引入 `ralph_done` 工具 | 2026-10 |
| 5 | 每轮 prompt 载体 | **引入任务文件，落工作区 `.ralph/<name>.md`**：每轮重读全文注入，模型回写进度/checklist；需 `workspace_read`/`workspace_write` 能力，并在 `/ralph start` 时提示 `.gitignore` | 2026-10 |
| 6 | 状态落点 | **状态落 `session_data_dir`，任务文件留工作区**：运行期状态归宿主管理（原子写、与会话同生命周期），人的产物归仓库；恢复靠重新 `/ralph start` 同名重读任务文件，不引入 `ownerSessionId` 仲裁 | 2026-10 |
| 7 | 命令面 | **`/ralph` 子命令族（最小集）**：`start <name> [--max N] [--promise TEXT]` / `stop` / `status` / `cancel <name>`；任务正文写在 `.ralph/<name>.md`，不塞进命令行 | 2026-10 |
| 8 | 安全阀默认值 | **上限默认 50（`--max 0` 显式才无限）+ 熔断默认开**：复读 1 轮 / 空转 3 轮，阈值口径与 sleep-continue 一致 | 2026-10 |

### 待决策

1. **每轮 prompt 的片段组成**：是否携带 Completion Gate / 反射检查点 / Stale Prompt Guard？

---

## 6. 实施方案（决策 1-9 的落地形态）

### 6.1 改动清单

新增：

- `crates/astrcode-extension-ralph/`（新 crate，只依赖插件系统：`astrcode-extension-sdk` + serde/thiserror/tokio/tracing）

修改：

- 根 `Cargo.toml`：`members` 是显式列表（`Cargo.toml:4-35`），需追加 `crates/astrcode-extension-ralph`
- `crates/astrcode-bundled-extensions/Cargo.toml`：加 `ralph` feature + optional dep，并加入 `default` feature 列表
- `crates/astrcode-bundled-extensions/src/lib.rs`：`BUNDLED_EXTENSION_CATALOG` 加一条 `astrcode-ralph`（`default_enabled: true`，`reject_non_empty_config`）
- 文档：`docs/crates.md`、`docs/configuration.md`、`docs/extension-system.md` 中列举内置扩展/扩展 id 的位置

### 6.2 模块骨架

```
crates/astrcode-extension-ralph/
  Cargo.toml
  src/lib.rs       // extension() 工厂 + manifest + register（装配钩子与命令）
  src/state.rs     // 落盘 LoopState + 每会话运行期进度（内存）
  src/plan.rs      // 判据链 decide() + <promise> 解析
  src/prompt.rs    // 每轮 prompt 组装 + 任务文件模板
  src/hook.rs      // continue_after_stop / post_tool_use / user_prompt_submit
  src/command.rs   // /ralph 子命令
  tests/loop_flow.rs
```

### 6.3 manifest 与能力

- id：`astrcode-ralph`；无 tool（不注册任何工具面，因此不受 bundled 测试「非 strict 工具」断言影响）
- capabilities：`SessionControl`（`defer_context`）、`WorkspaceRead`、`WorkspaceWrite`（任务文件）、`TurnContinuationControl`（续跑钩子）

能力到实现的对应关系（已核实）：

| 需要的能力 | 宿主入口 | 事实位置 |
|---|---|---|
| 注入本轮 prompt | `ExtensionHost::session_control().defer_context(HostSessionInputRequest)` | `sdk/src/host/mod.rs:61`、`sdk/src/host/domain_client.rs:277` |
| 读写任务文件 | `ExtensionHost::workspace().read/write(...)` | `sdk/src/host/mod.rs:154`、`sdk/src/host/domain_client.rs:459,466` |
| 状态落盘 | `ctx.paths().session_data_dir()` → `<session_store_dir>/extension_data/<ext_id>` | `sdk/src/extension/paths.rs:26-40` |

钩子调用上下文**已自带** session 与 workspace 作用域（`working_dir`、`session_store_dir` 均由 `ExtensionCallContextInput::from_hook` 填入，`astrcode-extensions/src/runner/host_invoker.rs:175-198`），所以 `workspace()` 与 `session_control()` 在 `continue_after_stop` 里可直接用，无需额外上下文。

### 6.4 钩子注册与判据链

```
on_continue_after_stop(priority = 50, ContinueAfterStopOptions::unlimited())
post_tool_use          (NonBlocking)  // 记录本 step 是否有工具调用 → 空转熔断
user_prompt_submit     (NonBlocking)  // 人工插话 → 重置复读/空转链（不清零 iteration）
```

`unlimited()` 是刻意的：宿主的 `limited(n)` 到顶后连 handler 都不再调用，扩展就失去「报告为什么停下」的机会；迭代上限由扩展自持（决策 8），与 sleep-continue 同一理由。

判据链（`plan::decide`，顺序即优先级）：

1. `<promise>` 命中 → `Completed`，`EndTurn`
2. `iteration >= max_iterations`（且 max > 0）→ `CapReached`，`EndTurn`
3. `no_progress_streak >= 1` → `NoProgress`，`EndTurn`
4. `idle_streak >= 3` → `Idle`，`EndTurn`
5. 否则 → `Continue{prompt}`：`defer_context(prompt)` 成功后 `ContinueOneStep`

`defer_context` 失败 → 记 `stop_reason = InjectFailed` 并 `EndTurn`，**不返回 `Err`**：宿主会把 handler 错误当作 turn 失败（sleep-continue 的 `hook.rs` 文档注释已写明这一点）。

`<promise>` 解析规则：取 `assistant_text` 里**第一个** `<promise>...</promise>`，与配置串做**字面量**比较（不做 glob、不忽略大小写）。promise 未配置时不参与判定。

### 6.5 状态与任务文件

状态：`session_data_dir()/loops/<name>.json`

```json
{
  "name": "fix-tests",
  "status": "active",
  "iteration": 3,
  "max_iterations": 50,
  "completion_promise": "DONE",
  "task_file": ".ralph/fix-tests.md",
  "idle_streak": 0,
  "no_progress_streak": 0,
  "last_assistant_text": "...",
  "last_advanced_at": 0,
  "stop_reason": null
}
```

- `status`：`active` / `paused` / `completed` / `stopped`
- 损坏的 JSON → 返回有类型错误并在 `/ralph status` 里显式报告，**不用 `unwrap_or_default()` 把损坏读成「没有 loop」**
- 任务文件：工作区 `.ralph/<name>.md`，每轮重读；不存在时由 `/ralph start` 写入模板（Goals / Checklist / Verification / Notes）
- 注入上限：任务文件读入上限 32 KiB，超出则截断并在注入文本里注明截断，避免每轮线性烧上下文

**一个会话同时只允许一个活跃 loop**：`<name>` 只作为 loop 标识（决定任务文件名与状态文件名），避免「本轮该推进哪个 loop」的歧义。

### 6.6 每轮 prompt

```markdown
## Ralph Loop — iteration {n}/{max}

### 任务文件 {task_file}
{任务文件全文}

### 本轮要求
1. 只做任务文件里未完成的一项，做完立刻把进度回写到任务文件（勾选 + Notes）。
2. 不得只凭 checklist 打勾宣布完成：必须跑一条外部可重跑的验证命令，
   并把命令、工作目录、环境变量、产物路径写进任务文件。
3. 全部完成后，在回复最后一行输出 <promise>{promise}</promise>。
```

`--promise` 未配置时省略第 3 条（loop 只能靠上限/熔断停，与决策 8 一致）。

### 6.7 命令面

```
/ralph start <name> [--max N] [--promise TEXT]   # 启动；同名 paused → 恢复 iteration，否则新建
/ralph stop                                      # 暂停当前 loop（保留状态与任务文件）
/ralph status                                    # 状态 + 接管事实
/ralph cancel <name>                             # 结束并删除状态文件（任务文件保留）
```

- `requires_idle: false`：`cancel` 必须能在 turn 运行中执行，这是唯一的逃生通道
- `start` 时若已有**活跃** loop → 报错并提示先 `cancel`
- `start` 时若 `.ralph/` 不在 `.gitignore` → 在输出里提示
- `/ralph status` 显式报告接管事实（决策 2 的补偿）：列出 `kanban(60) > ralph(50) > goal(40) > sleep-continue(0)` 的排序，并说明「本会话若看板在驱动，Ralph 不介入；Ralph 活跃期间 sleep-continue 不会生效」

### 6.8 兼容性落点（对应 §3）

| 对象 | 落点 |
|---|---|
| 看板 | Ralph = 50 < kanban = 60；看板会话里 kanban 先返回 `ContinueOneStep`，Ralph 的 handler 当轮不被调用，**看板流程零改动、零影响** |
| sleep-continue | Ralph = 50 > sleep = 0；Ralph 活跃期间 sleep 的熔断/重试/提问自动应答不执行，由 `/ralph status` 显式提示，不改对端插件 |
| goal | Ralph = 50 > goal = 40，同上；goal 的 `on_before_provider_request` 注入与 Ralph 无冲突（不同钩子） |
| 预算计数 | Ralph 自持 `iteration` 落盘，不读 `continuations_this_turn`（那是全局共享计数器） |

### 6.9 测试计划

单元测试（模块内，只测能暴露真实失败模式的部分）：

- `plan::promise`：取第一个标签；字面量比较（`DONE` ≠ `done`）；无标签返回 `None`；标签外文本不误匹配
- `plan::decide`：判据链顺序（promise 命中优先于上限；上限优先于熔断；熔断优先于继续）
- `state`：落盘/读取往返；损坏 JSON 返回有类型错误
- `prompt::render`：有/无 promise 两种形态；截断路径

集成测试 `tests/loop_flow.rs`：注册扩展 → 触发 `continue_after_stop` → 断言返回 `ContinueOneStep` 且宿主记录了 `defer_context`；再断言 promise 命中时返回 `EndTurn` 且状态标记 `completed`。若 SDK 现有 `testing` 脚手架（`sdk/src/testing.rs` 的 `HookContextBuilder`）不足以覆盖，退化为模块内单测并在回复里说明。

### 6.10 验证命令

```
cargo fmt --check
cargo test -p astrcode-extension-ralph
cargo clippy -p astrcode-extension-ralph --all-targets -- -D warnings
```

因同时改动 `astrcode-bundled-extensions` 与根 `Cargo.toml`，收尾再跑一次全量：

```
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

### 6.11 风险与已知边界

1. **优先级垄断导致的静默失效**：已决策接受；`/ralph status` 提示 + 文档写明是唯一补偿手段。
2. **`<promise>` 只匹配文本**：模型若把完成串写进工具参数而非回复文本，检测不到。缓解：prompt 明确要求「回复最后一行输出」。
3. **用户无法在轮次间插话**：hook 强制推进的固有代价；逃生通道是 `/ralph cancel`（或取消 turn）。
4. **任务文件全文每轮注入**：上下文线性增长；靠 32 KiB 上限 + 截断提示兜底，但长任务仍需用户自己控制任务文件长度。
5. **进程重启后不自动恢复**：状态在 `session_data_dir`，会话级；恢复靠重新 `/ralph start` 同名（决策 6 已接受）。

---

## 7. 事实清单（可追溯）

| 事实 | 来源 |
|---|---|
| Stop hook 阻断退出并回灌 prompt | `anthropics/claude-code/plugins/ralph-wiggum/hooks/stop-hook.sh` |
| 状态文件 frontmatter 字段与语义 | 同上 + `scripts/setup-ralph-loop.sh` |
| `<promise>` 精确字面量比较、取第一个标签 | 同上（Perl 单行 + `[[ "$X" = "$Y" ]]`） |
| Completion Gate / Stale Prompt Guard / Reflection | `@tmustier/pi-ralph-wiggum` `index.ts` + `SKILL.md` |
| `ownerSessionId` 会话归属 | 同上 |
| `/loop [count\|duration] [--while\|--until '<cmd>'] [prompt]` | `can1357/oh-my-pi` `packages/coding-agent/src/modes/loop-limit.ts` |
| 退出码权威、exit 1 才是「假」、>1 视为条件损坏 | 同上 `loop-condition.ts` |
| 门禁顺序（预算→条件→忙检查→消费预算→投递）、800ms Esc 窗口 | 同上 `interactive-mode.ts` `#runLoopIteration` |
| sleep-continue 判据链与默认值 | `astrcodey-extensions/crates/astrcode-ext-sleep-continue/src/{plan,config}.rs` |
| `defer_context` 注入 + 成功才 `ContinueOneStep` | 同上 `src/hook.rs` `continue_with` |
| 宿主钩子语义：降序、首个 `ContinueOneStep` 生效 | `crates/astrcode-extensions/src/runner/mod.rs:2117-2150` |
| 钩子载荷含 `assistant_text` / `continuations_this_turn` | `crates/astrcode-extension-sdk/src/extension/hooks/contexts.rs:234` |
| 续跑在同一 turn 内再跑一个 step | `crates/astrcode-session/src/turn_runner.rs:421,1004` |
| 看板续跑（priority 60 / limited(200) / implementing） | `crates/astrcode-extension-kanban/src/lib.rs`、`docs/kanban-extension-design.md` §6.4 |
| goal 续跑（priority 40 / unlimited） | `crates/astrcode-extension-goal/src/lib.rs:149` |
| 能力枚举变体（SessionControl / WorkspaceRead / WorkspaceWrite / TurnContinuationControl） | `crates/astrcode-extension-sdk/src/wire/capability.rs:46-69` |
| 扩展数据目录命名空间 `<store>/extension_data/<ext_id>` | `crates/astrcode-extension-sdk/src/extension/paths.rs:26-40` |
| 钩子调用上下文自带 session + workspace 作用域 | `crates/astrcode-extensions/src/runner/host_invoker.rs:175-198` |
| `defer_context` 客户端签名 | `crates/astrcode-extension-sdk/src/host/domain_client.rs:277` |
| workspace `read` / `write` 客户端签名 | `crates/astrcode-extension-sdk/src/host/domain_client.rs:459,466` |
| worker hook 默认优先级 0（未链 `.priority()` 即缺省） | `crates/astrcode-extension-worker/src/worker/mod.rs:94` |
| 内置扩展目录 + feature 开关 | `crates/astrcode-bundled-extensions/src/lib.rs:41-126`、同 crate `Cargo.toml:8-21` |
| workspace members 为显式列表 | 根 `Cargo.toml:4-35` |
