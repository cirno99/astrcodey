# 看板自动化扩展设计

> 状态：设计中（分支 `feat/kanban-board`）
> 关联：`docs/extension-system.md`、`docs/extension-author-guide.md`、`docs/extension-hook-matrix.md`

## 1. 目标

让用户在前端看板上写下需求，由 AstrCode 自动检测并推进：先按预设提示词分析需求，再实施，直到卡片进入终态。

非目标：

- 不做通用工作流引擎。看板只有固定的六列状态机，不做用户自定义列。
- 不做跨机器同步。看板数据只落在本机扩展数据目录。
- 不做多用户协作、权限、通知。

## 2. 形态

新增内置扩展 `astrcode-kanban`（crate `astrcode-extension-kanban`），只依赖插件系统，不依赖项目其他内容。

它承担两件事：

1. **看板数据源**：持久化卡片，通过认证 HTTP 路由向前端提供 CRUD。
2. **自动化执行器**：常驻轮询任务领取 `ready` 卡片，创建 root session 并投递分析 / 实施 turn。

前端新增看板页（方案 B），其导航入口与页面可见性由该扩展的启用状态决定。

**自动化与前端解耦**：第 6 章的轮询、领取、投递全部在宿主侧的扩展进程里完成，前端既不触发也不维持它。前端未启动、未连接、或看板页没被打开时，自动化照常推进；前端只是看板数据的读写界面。因此无头运行 = 用 `astrcode server` 起宿主，不需要任何前端进程。

## 3. 状态机

```
backlog ──(用户拖动)──▶ ready ──(扩展领取)──▶ analyzing ──(分析 turn 结束)──▶ implementing ──(agent 标记)──▶ done
                          ▲                        │                              │
                          │                        │                              │
                          └──── 失败重试 ───────────┘                              │
                                                   └──(尝试耗尽 / agent 标记)──▶ blocked
```

| 列 | 语义 | 谁迁移 |
|---|---|---|
| `backlog` | 已录入、不参与自动化 | 用户 |
| `ready` | 待领取 | 用户 |
| `analyzing` | 正在跑分析 turn | 扩展 |
| `implementing` | 正在跑实施 turn | 扩展 |
| `done` | 完成（终态） | agent |
| `blocked` | 需要人工介入（终态） | agent 或扩展 |

不变量：

- 终态（`done` / `blocked`）不会再被自动化领取。
- 只有扩展把卡片迁入 `analyzing` / `implementing`；用户与 agent 不能直接写入这两列。
- 一张卡片在任一时刻最多绑定一个 session。

## 4. 数据模型

```rust
enum CardColumn { Backlog, Ready, Analyzing, Implementing, Done, Blocked }

struct Card {
    id: String,             // uuid v4
    title: String,
    body: String,           // 需求正文
    column: CardColumn,
    working_dir: String,    // 绝对路径
    session_id: Option<String>,
    attempt: u32,           // 已投递的 turn 轮次
    error_retries: u32,     // 执行失败重试次数（与 attempt 语义分离）
    note: Option<String>,   // agent 或扩展写入的最近一条说明
    created_at: String,     // RFC 3339
    updated_at: String,
}

struct Board { cards: Vec<Card> }
```

持久化：`<global_data_dir>/board.json`，原子写（写临时文件后 `rename`）。

损坏处理：解析失败时返回有类型的错误，不静默回退为空看板——那会把数据损坏伪装成「看板是空的」。

## 5. 配置

`config.toml` 的 `extensions.astrcode-kanban`，camelCase，`deny_unknown_fields`：

```jsonc
{
  "automationEnabled": false,        // 自动化总开关；与扩展启用状态相互独立
  "pollIntervalSecs": 30,
  "maxConcurrentCards": 1,
  "maxAttemptsPerCard": 10,
  "maxContinuationsPerTurn": 200,
  "maxErrorRetriesPerCard": 3,      // 执行失败重试次数上限；与 maxAttemptsPerCard 语义分离
  "defaultWorkingDir": null,         // 新建卡片时的默认工作目录
  "analyzePrompt": null,             // null 时用内置默认
  "implementPrompt": null
}
```

扩展启用 ≠ 自动化启用：启用插件只是让看板页出现；是否自动推进由 `automationEnabled` 决定。

## 6. 自动化循环

### 6.1 轮询任务

`Extension::start()` 在 `automationEnabled` 时注册 `ctx.tasks().spawn("kanban-automation", ...)`，循环体为 `select! { cancellation.cancelled(), sleep(poll_interval) }`。

每轮 `tick()`：

1. 从磁盘重新加载看板（不信任内存快照）。
2. 对 `analyzing` / `implementing` 的卡片做一致性检查（见 6.3）。
3. 统计在跑卡片数，若 `< maxConcurrentCards` 则领取 `ready` 卡片。

### 6.2 领取与执行

领取是「先落盘、再执行」：把卡片置为 `analyzing`（已有 session 时直接置为 `implementing`）并持久化成功之后，才 `spawn` 该卡片的执行任务。这样进程重启不会出现「session 已建但看板不知道」。

`attempt` 只在每次投递实施 turn 时递增，由它约束 6.2 第 8 步的重试上限。

`run_card`：

1. `create_root(working_dir, tool_selection)` 建 root session，`tool_selection` 排除 `askUser`。
2. 落盘 `session_id`，列置 `analyzing`。
3. `submit_root_turn(分析提示词, wait_for_result = true)`。
4. 重新读盘；若卡片已是终态则返回。
5. 列置 `implementing` 并落盘。
6. `submit_root_turn(实施提示词, wait_for_result = true)`。
7. 重新读盘；若卡片已是终态则返回。
8. 重读卡片：已是终态则返回；`attempt >= maxAttemptsPerCard` 则置 `blocked`；否则 `attempt += 1` 并回到 6。

无人值守：卡片会话用 `tool_selection = all_except(["askUser"])` 排除提问工具。看板运行期间没有用户可以应答，留着它只会让 turn 挂起到 ask-user 扩展的超时（无 `recommended` 选项时 300 秒）再拿到一个错误结果；排除之后模型无从提问，只能自行决策。工具名按字面量匹配——内置插件只能依赖插件系统，无法引用 `astrcode-extension-ask-user` 的常量。

### 6.3 一致性检查

扩展在内存中维护「本进程正在执行」的卡片集合：领取时加入，任务结束时移除（由 `Drop` 保证）。每轮调度先把运行中列里不在该集合中的卡片退回 `ready`。

不用 `root_state(session)` 判断存活：session 空闲既可能是「turn 结束但 agent 没标记」，也可能是「刚领取还没投递」，两者无法区分；进程内集合则精确对应「这个扩展实例是否还在推进这张卡」。

退回时保留 `session_id`，重新领取会复用该 session 直接续做实施阶段，不重复分析。

### 6.4 续跑

注册 `on_continue_after_stop`，按 session 归属判断：卡片处于 `implementing` 时返回 `ContinueOneStep`，否则 `EndTurn`。

注册时固定 `ContinueAfterStopOptions::limited(HARD_CONTINUATION_LIMIT)`（200）作为硬闸门；可配置的 `maxContinuationsPerTurn` 由 handler 读取运行期配置后自行判定——`register()` 拿不到配置，而热改配置不应重新注册 hook。默认值直接取硬闸门常量，单轮默认就能跑满 200 次续跑；想调到硬闸门之上需要同时改代码常量。

这让单次实施 turn 可以持续工作，而不必靠反复重投来「续命」。

### 6.5 执行失败处置

`submit_root_turn` 失败时不再一律置 `blocked`，而是先按错误文本分类再决定处置：

| 分类 | 文本特征 | 处置 |
|---|---|---|
| `Degenerate`（模型重复输出） | `degenerate repetition detected` | 回收 session，清空 `session_id` 并把 `attempt` 归零，退回 `ready`（下次领取重新走分析阶段） |
| `Transient`（可重试） | `transport` / `timed out` / `connection reset` / `broken pipe` / `terminated by the server` / `status=429` / `5xx` 等 | 保留 session，退回 `ready`，下次领取直接续做实施 |
| `Permanent`（不可重试） | `model not found` / `status=401` / `403` / `404` / `quota` 等 | 置 `blocked`，`note` 写入原始错误 |
| 无法识别 | —— | 按 `Transient` 处理（保守：宁可多试几次） |

重试预算由 `error_retries` 与 `maxErrorRetriesPerCard` 约束：每处置一次失败计数 +1，`error_retries >= maxErrorRetriesPerCard` 时无论分类一律置 `blocked`。它与 `attempt` 语义分离：`attempt` 约束正常推进的轮次，`error_retries` 约束异常重试。

分类只能基于文本，因为宿主把 turn 失败作为 `HostError` 消息交给扩展。宿主文案变化会让分类静默降级为 `Transient`，代价是多烧几次预算再 `blocked`，不会损坏数据。

退避：退回 `ready` 后由下一轮 tick 领取，天然隔一个 `pollIntervalSecs`，不额外 sleep。

### 6.6 退化重复守卫（宿主侧）

模型陷入「短时间内大量重复文字」时，扩展看不到流式输出（`submit_root_turn` 只在 turn 结束后返回），所以守卫做在宿主流式层 `crates/astrcode-session/src/repetition_guard.rs`。

判定按**片段**而非整行：换行与中文句末标点总是片段边界，`.` / `!` / `?` 只在后接空白时算句末（避免把 `foo.bar()`、`3.14` 切碎）。最近 40 个片段的去重数 ≤ 16 且平均长度 ≤ 32 字符，连续两个窗口满足即判定退化，中断当前生成并让 turn 以 `TurnError::DegenerateRepetition` 结束。正文与思考各用一个独立窗口（`RepetitionStream::{Text, Thinking}`）——思考里的自我复读通常没有换行，只能靠句末标点切分；两者混进同一个窗口会互相稀释。

开销约束（每个流式增量都会走一遍）：扫描游标只前进不回退，增量只扫新增字节；去重数与总长度在入窗 / 出窗时增量维护，判定本身是 O(1)；单个片段超过 64 KiB 未出现边界即判定为长文输出并重置统计。内存与单次扫描量都不随输出长度增长。

错误文案以 `degenerate repetition detected` 开头（常量定义在 `repetition_guard.rs`，与错误文案的一致性由单测绑定），并带上通道名（`正文` / `思考`）。扩展按字面量识别——内置插件只能依赖插件系统，无法引用宿主常量。

守卫对所有会话生效，不只作用于看板；阈值刻意保守，误杀的代价是一次 turn 失败。

## 7. Agent 接口

只暴露一个工具：

```
kanban_update_card(cardId: string, column: "done" | "blocked", note?: string)
```

理由：卡片正文已经写在投递的提示词里，agent 不需要查询工具；它唯一必须表达的是「做完了」或「卡住了」。`analyzing` / `implementing` 由扩展独占，工具不接受这两个取值。

提示词中显式给出 `cardId` 与「完成后必须调用 `kanban_update_card`」的约定。

## 8. HTTP 接口

认证路由，挂载于 `/api/extensions/astrcode-kanban/`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/board` | 返回全部卡片 |
| POST | `/cards` | 新建卡片 |
| PATCH | `/cards/{cardId}` | 更新标题 / 正文 / 工作目录 / 列 |
| DELETE | `/cards/{cardId}` | 删除卡片 |

`PATCH` 是唯一允许用户改列的入口，且拒绝写入 `analyzing` / `implementing`。

## 9. 前端

- 新增 `components/Kanban/KanbanPage.tsx`：六列泳道、卡片增删改、列间移动。
- `App.tsx` 的 `MainView` 增加 `'kanban'`。
- `Sidebar.tsx` 增加入口按钮，仅在扩展 `enabled && loaded` 时渲染。
- 扩展被禁用时，若当前正处于看板视图则回落到 `chat`。
- 扩展启用状态复用 `refreshExtensionData` 里已有的 `askUserExtensionAvailable` 同款派生方式。

前端只经 `/api/extensions/astrcode-kanban/*` 读写，不直连扩展进程。

反向不成立：自动化不依赖前端的轮询或页面存活。看板页的 5 秒轮询只刷新展示，停掉它不会让卡片卡在 `implementing`。

## 10. 测试

- 看板存储：往返序列化、原子写、损坏文件返回有类型错误。
- 状态机：终态不可领取、用户不可写运行中列、尝试耗尽转 `blocked`。
- 配置校验：合法配置通过、未知字段与越界值被拒。
- 失败分类：真实错误原文（传输中断 / 连接重置 / 流被终止 / 模型不存在）与退化重复文本的表驱动用例；重试预算内外分支。
- 旧看板兼容：缺少 `error_retries` 的 `board.json` 仍可读，缺字段取 0。
- 退化重复守卫：循环短语样例必须触发，正常散文 / 长行 / 短输出不得触发。
- 内置目录测试：`astrcode-kanban` 进入 `validate_bundled_extension_configs` 用例。

## 11. 已知风险

- **幂等**：进程崩溃或扩展重载会留下 `analyzing` / `implementing` 但没有存活任务的卡片，靠 6.3 的存活集合检查兜底；该检查必须每轮都跑。
- **并发**：`maxConcurrentCards` 是唯一闸门。多张卡片指向同一工作目录时仍会互相踩工作区，本设计不做工作区互斥。
- **空转**：agent 不调用 `kanban_update_card` 时，扩展会重投到 `maxAttemptsPerCard` 为止，期间持续消耗 token。
- **可见性**：自动化失败只写 tracing 与卡片 `note`，用户需要主动看看板才能发现。
- **分类脆弱**：失败分类基于错误文本，宿主文案一变就会静默降级为 `Transient`，最多烧完 `maxErrorRetriesPerCard` 次再 `blocked`。
- **守卫边界**：退化重复守卫只覆盖正文重复，不覆盖工具调用重复（已有 `tool_deduplicator`）与 thinking 重复；无换行的长串重复也不在覆盖范围内。
- **运行前提**：manifest 要求 `authenticated_http` 传输，只有 `astrcode server`（以及桌面端拉起的 sidecar）会加载本扩展；`tui` / `exec` / `acp` 用的是空传输 profile，扩展会被准入拒绝，自动化不会运行。无头跑自动化必须走 server 模式。
