# 分配优化清单（`allocator_api` 实验）

> 状态图例：`[x]` 已落地并验证 · `[ ]` 待做 · `[-]` 评估后不做（附原因）
> 实测数据来自本机 nightly `1.100.0-nightly (5ceaf6608 2026-09-25)`，测量方式是
> 线程局部分配计数（`crates/astrcode-ai/src/alloc_probe.rs`），非墙钟猜测。

## 结论摘要

1. **可落地的收益全部来自缓冲复用，不来自 `allocator_api`。** 最高频的 SSE 流解码
   路径经复写后，稳态分配从 **3 次/chunk 降到 0 次/chunk**，release 墙钟 **−40%**。
2. **`allocator_api` 在本仓库现有热路径上没有净收益**，原因见
   [「`allocator_api` 适用性结论」](#allocator_api-适用性结论)：主导开销是
   `String` 与 `serde_json::Value`（两者都不是 allocator 参数化类型），而
   arena 方案被 `&Bump: !Send` 与 `#[async_trait]` 的 Send 约束挡在异步路径之外。
3. 该特性在本 toolchain 上**已部分稳定**：`Vec<T, A>` / `Box<T, A>` 无需 feature gate，
   只有 `VecDeque` / `Arc` / `BTreeMap` 仍需 `#![feature(allocator_ext)]`。

## 环境事实（已核实）

| 事实 | 证据 |
| --- | --- |
| toolchain 已是 nightly | `rust-toolchain.toml` → `channel = "nightly"`；`rustc 1.100.0-nightly` |
| `allocator_api` 已被 `allocator_ext` 取代 | 编译时 `stable_features` warning：`partially stabilized since 1.100.0-nightly and is succeeded by the feature allocator_ext` |
| `Vec<T, A>` / `Box<T, A>` / `Vec::new_in` / `Vec::with_capacity_in` / `Vec<u8, A>` 作为 `io::Write` **无需 gate** | `/tmp/alloc-probe` 探针在无 `#![feature]` 下编译通过 |
| `VecDeque<T, A>` / `Arc<T, A>` 仍需 `#![feature(allocator_ext)]` | 同上探针报 `E0658`（issue #163177） |
| `BTreeMap<K, V, A>` 额外需要不稳定 trait `AllocatorClone` | 探针报 `E0277`：`the trait bound A: AllocatorClone is not satisfied` |
| `bumpalo 3.20.3` 可为 `&Bump` 实现 `Allocator` | 需开启其 `allocator_api` feature（该 feature 内部 `#![feature(allocator_api)]`，**要求 nightly**） |
| `Bump: Send` 但 **`!Sync`**，`&Bump: !Send` | 探针：`` `Cell<NonNull<ChunkFooter>>` cannot be shared between threads safely `` |
| provider 流式 future 必须 `Send` | `crates/astrcode-core/src/llm.rs:1003` `#[async_trait::async_trait] pub trait LlmProvider: Send + Sync` |
| 全局分配器已是 jemalloc | `astrcode-server/src/main.rs:19`、`http_main.rs:12`、`astrcode-cli/src/main.rs:21`（`cfg(not(target_env = "msvc"))`） |
| 仓库内此前零 `allocator_api` 使用 | `grep -rn "feature(" crates` 无结果 |

## 候选清单

### A. SSE 流解码（最高频路径）

`crates/astrcode-ai/src/stream_decoder.rs`，调用点 `crates/astrcode-ai/src/common.rs:546`

- [x] `SseLineReader::push_chunk` 逐行 `to_string()` → 改为返回借用切片 `Lines<'_>`
- [x] `SseLineReader::push_chunk` 每 chunk 一个 `Vec<String>` → `line_ranges` 复用容量
- [x] `buffer.drain(..=pos)` 逐行 O(n) 搬移 → 消费游标 + 8 KiB 阈值压缩
- [x] `Utf8StreamDecoder` 每 chunk 一个输出 `String` → 复用 `decoded` 缓冲
- [x] `Utf8StreamDecoder` 不完整尾序列的 `split_off` 分配 → 改为 `drain`

**实测**（2048 chunks × `data: {"n":N}\n\n`，即每 chunk 2 行）：

| 指标 | 变更前 | 变更后 |
| --- | --- | --- |
| 稳态分配次数 | 6144（3/chunk） | **0** |
| release 墙钟（16 × 4096 chunks） | 3.493 ms | **2.080 ms（−40%）** |

### B. 事件日志反向扫描

`crates/astrcode-storage/src/event_log.rs:227` `replay_events_before_at_path`

- [x] 每轮 `vec![0; n]` 窗口分配 → 复用一个 `window`
- [x] 每轮 `chunk[..first_newline].to_vec()` 残片分配 → 复用 `leading_fragment`

每 64 KiB 扫描窗口减少 2 次堆分配；由既有 31 个 storage 测试覆盖（含
`event_log_replays_bounded_pages_before_exclusive_cursor`）。**未单独做基准测量。**

### C. 事件日志写入路径

`crates/astrcode-storage/src/event_log.rs:453` `append_stored_batch`

- [-] `let mut encoded = Vec::new()` 未预分配容量。
  **不做**：该路径由 `fsync` 主导，一次追加批次的单次分配不可测；复用 `WriterState`
  上的 scratch 缓冲会让 `write_committed_record(&mut self)` 的借用结构变别扭，不值得。

### D. 事件回放容量预留

`crates/astrcode-storage/src/event_log.rs:208` `replay_events_at_path`

- [-] `Vec::new()` 无容量提示。
  **不做**：`max_events` 由调用方传入，直接 `with_capacity(max_events)` 在大 limit 下
  会提前占用远超实际需要的内存，收益（省约 12 次 realloc）与风险不成比例。

### E. 服务器 SSE / HTTP 投影

`crates/astrcode-server/src/http/stream.rs`、`http/projection/live.rs`、`projection/blocks.rs`

- [-] 每请求作用域的 `VecDeque<SseItem>` 与块构建容器。
  **不做**：`VecDeque<T, A>` 需要 `allocator_ext`，且其中的 `SseItem` /
  `ConversationBlockDto` 都是拥有 `String` 的 wire DTO，arena 无法覆盖其主体开销。

### F. S5R 帧协议

`crates/astrcode-extension-sdk/src/wire/frame.rs`

- [x] `read_frame_from` 的 `header: Vec::new()` 逐字节增长 → 已改为
  `[u8; MAX_FRAME_HEADER_BYTES]` 定长栈缓冲，每帧省 1 次分配及若干 realloc。
  帧格式不变，仅内部读缓冲移到栈上。
- [-] `frame_payload` 把 header 与 payload 拼成一个 `Vec<u8>` → 可改为两次
  `write_all`（`BufWriter` 会合并）。**不做**：`frame_payload` 是 SDK 公开 API，
  为单次分配改动公开签名不划算，留待有实测需求时单独评审。

### G. 工具调用 JSON 修复

`crates/astrcode-session/src/tool_json_repair.rs:56`

- [-] 冷路径，且已有「正常路径零分配」的前置守卫（`serde_json::from_str` 成功即返回）。

### H. `DurableEventPayload` 编解码

- [-] 每事件一次 `serde_json` 解析，owned `String` 主导。`serde_json` 不支持自定义
  分配器，`allocator_api` 不可达。

## `allocator_api` 适用性结论

**结论：在本仓库当前的后端热路径上，`allocator_api` 没有可落地的净收益。** 三条独立理由：

1. **主导开销不在可参数化的容器上。** 仓库有 1425 处 `serde_json::` 调用与大量
   owned `String` 构造，而 `String` 与 `serde_json::Value` 都不是 allocator 参数化类型。
   事件日志每行一次 `serde_json::from_str::<StoredEvent>` 产生的是一整棵 owned 树，
   arena 无法接管。
2. **异步路径上无法持有 arena。** `&Bump` 不是 `Send`（见上表），而
   `LlmProvider` 的 `#[async_trait]` 要求 future 为 `Send`。`consume_sse_lines` 在
   循环中跨 `.await` 持有解码器，因此不能把 `&Bump` 穿进去。
   退而求其次让结构体**自持** `Bump` 也不成立：`Vec<T, A>` 会按值持有 `A`，于是每个
   缓冲各带一个 arena，反而多出分配；而共享 arena 需要 `Arc<Bump>`，但 `Bump: !Sync`
   使 `Arc<Bump>` 也不是 `Send`。
3. **可参数化的容器已经被复用覆盖。** A/B 两项落地后，这些容器在稳态下分配次数已经是
   0；arena 无法比 0 更好。

**若将来要引入 `allocator_api`，唯一站得住的落点是同步路径 + 单个作用域内「大量小对象
同生共死」的场景**——本仓库目前没有这样的热点。需要跨线程共享时，必须先有一个
`Send + Sync` 的自定义分配器实现（而不是 `bumpalo::Bump`）。

**成本提示**：开启 `bumpalo` 的 `allocator_api` feature 会让依赖链要求 nightly
（该 feature 内部启用 `#![feature(allocator_api)]`）。本工作区已是 nightly，但
`workspace.package.rust-version = "1.88"` 的声明会因此失真。

## 验证方式

```bash
cargo fmt --check
cargo test -p astrcode-ai stream_decoder      # 含稳态零分配预算测试
cargo test -p astrcode-storage
cargo clippy -p astrcode-ai -p astrcode-storage --all-targets -- -D warnings
```

稳态零分配由 `stream_decoder::tests::stream_decoding_steady_state_allocates_nothing`
持续守住：它用线程局部分配计数器断言「预热到稳态后，2048 个 chunk 的解码过程分配次数为 0」。
变更前的同工作负载为 6144 次，因此该测试能真实暴露回退。
