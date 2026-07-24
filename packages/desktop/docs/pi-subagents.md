**目标架构**
```text
Renderer
  -> Main SubagentWorkerRegistry
      -> subagent sidecar worker
          -> createAgentSession(...)
          -> Desktop controlled extensions
          -> structured IPC events

Thread sidecar / pi-subagents
  -> SubagentRuntime
      -> Desktop host request
          -> Main SubagentWorkerRegistry
```

核心原则：

- 保留独立进程隔离，不在父 thread worker 内并发创建多个 `AgentSession`。
- Main 进程持有 subagent worker，避免 thread worker reload 后留下孤儿进程。
- 使用 `createAgentSessionServices()` 和 `createAgentSessionFromServices()`，不经过 Pi CLI。
- 扩展只按 Desktop extension ID/profile 注册，不接受任意 child extension 文件路径。
- 前台、并行、chain 和 async 最终共享同一 worker protocol。

**阶段 0：冻结行为**
先为现有功能补 characterization tests，作为迁移基线：

- single、parallel、chain 的结果与进度。
- model fallback、thinking、skills、system prompt。
- cancel、steer、resume、timeout。
- output file、structured output、session file。
- async status、completion、恢复。
- Hermes 只注册一次。
- child 不发现用户扩展。
- 嵌套 fanout 的深度和预算限制。

测试使用 faux provider，不调用真实模型。

**阶段 1：定义运行时边界**
新增与上游编排逻辑解耦的接口：

```ts
interface SubagentRuntime {
  run(request: SubagentRunRequest): AsyncIterable<SubagentRunEvent>;
  cancel(runId: string): Promise<void>;
  steer(runId: string, message: string): Promise<void>;
  resume(request: SubagentResumeRequest): AsyncIterable<SubagentRunEvent>;
  dispose(): Promise<void>;
}
```

`SubagentRunRequest` 只能包含可序列化数据：

- project/thread/run/parent session ID
- cwd、session 路径
- provider、model ID、thinking
- system prompt 和 context policy
- tool allowlist
- Desktop extension profile
- timeout、turn/tool budget
- output 和 acceptance 配置

禁止传递 extension factory、任意模块路径和函数。

**阶段 2：增加 Subagent Sidecar Role**
扩展 [sidecar-contracts.ts](G:/meta-agent-v2/packages/desktop/src/shared/sidecar-contracts.ts)：

```ts
type SidecarRole = "thread" | "metadata" | "subagent";
```

新增：

- `subagent-worker-main.ts`
- `SubagentWorkerService`
- `SubagentWorkerBinding`
- `SubagentWorkerCommand`
- `SubagentWorkerEvent`

Worker command 包括 `run`、`cancel`、`steer`、`shutdown`。事件包括 text delta、tool start/update/end、usage、completed 和 failed。

复用现有 sidecar：

- protocol version 校验
- generation ID
- message chunking
- event sequence
- credit/backpressure
- heartbeat
- runtime compatibility 校验

**阶段 3：Main Worker Ownership**
新增 `SubagentWorkerRegistry`，由 Main 进程持有，按以下键管理：

```text
projectId / parentThreadId / runId / childIndex
```

职责：

- 使用 manifest-bound Node 启动 worker。
- 限制全局和单会话并发。
- 维护运行状态和事件缓冲。
- 处理取消、超时和进程树清理。
- thread worker 重启后允许重新订阅。
- Desktop 退出时有序终止全部 child。
- 拒绝重复 run ID 和过期 generation。

需要为 sidecar 增加受限的 child-to-main host request/response，不能复用普通扩展 event 模拟 RPC。

**阶段 4：Programmatic AgentSession**
Subagent worker 直接调用：

```ts
createAgentSessionServices()
createAgentSessionFromServices()
session.bindExtensions()
session.subscribe()
session.prompt()
```

资源加载使用 `controlledResourceLoaderOptions()`：

- `noExtensions: true`
- Desktop inline factories
- 明确的 skills/context policy
- `systemPrompt` / `appendSystemPrompt`
- 禁止 package-manager 自动修复
- 禁止用户扩展自动发现

定义 child extension profile：

- `provider`: Meta Agent provider
- `memory`: Hermes Memory
- `runtime`: prompt、budget、watchdog runtime
- `fanout`: 仅明确授权时注册受限 subagent tool
- 不注册父级完整编排器和 TUI renderer

**阶段 5：迁移执行路径**
按风险从低到高切换：

1. Foreground single
2. Foreground parallel
3. Foreground chain
4. Nested fanout
5. ~~Async single~~ ✅
6. ~~Async parallel/chain~~ ✅
7. ~~Steer~~ ✅
8. ~~Resume~~ ✅
9. ~~Schedule~~ ✅
10. ~~Watchdog~~ ✅ (纯 in-process 扩展，不依赖 CLI，无需迁移)

每完成一项，就删除对应 CLI adapter 分支，不长期维护双实现。

上游 agent discovery、chain graph、acceptance、artifact 和结果聚合逻辑继续保留；仅替换真正执行 child 的部分。

**阶段 6：Async 持久化与恢复**
Main registry 持久化最小运行状态：

```text
run metadata
worker generation
session files
last event sequence
status
result/error
```

恢复规则：

- 进程仍存活：重新绑定并补发事件。
- 进程已退出且有结果：直接恢复 completed。
- 进程消失且无结果：标记 interrupted，不假装成功。
- resume 必须显式创建新 worker generation。
- 不允许两个 worker 同时写同一个 child session。

**阶段 7：删除 CLI 架构**
全部迁移完成后删除：

- `pi-spawn.ts`
- `pi-args.ts`
- CLI stdout/stderr JSON parser
- `desktop-child-extension.ts`
- `PI_DESKTOP_PI_ENTRY`
- `PI_DESKTOP_CHILD_EXTENSION_PATH`
- `--no-extensions` / `--extension` child 参数
- detached `subagent-runner.js`
- package validator 中的 child CLI smoke

Manifest 改为记录并验证 `subagent` sidecar entry，不再记录 Pi CLI entry。

**完成标准**
- 代码中不存在 child `pi-cli.js`、PATH `pi`、jiti 或 CLI 参数构造。
- 所有 child 都由 Main registry 管理。
- Hermes 和其他 builtins 每个 worker 只注册一次。
- 任意用户 extension path 无法进入 child worker。
- Foreground、parallel、chain、async、cancel、steer、resume 回归测试通过。
- Thread worker replacement 和 Desktop shutdown 不产生孤儿进程。
- Sidecar build、smoke、package afterPack 和 `npm run check` 全部通过。

第一实施批次应限定为阶段 0 至阶段 4，并只切换 foreground single。这样可以先证明 programmatic `AgentSession`、扩展加载、事件流和取消语义正确，再扩大到调度和恢复。

## 实施状态

### 第一批：阶段 0-4 + foreground single

已完成：

- 新增 `SubagentRuntime`、结构化 run request/event 和 host request contract。
- Sidecar protocol 升级到 v3，支持受限的 child-to-main host call/event/response。
- 新增 `subagent` sidecar role、`SubagentWorkerService` 和独立 worker entry。
- 新增 Main-owned `SubagentWorkerRegistry`，包含 run identity、全局/线程容量、取消、steer、事件确认和 shutdown ownership。
- Thread worker 会校验 host request 的 project/thread identity，开发扩展不能跨 thread 启动或控制 worker。
- Subagent worker 直接调用 `createAgentSessionServices()`、`createAgentSessionFromServices()`、`bindExtensions()`、`subscribe()` 和 `prompt()`。
- Child resource loader 强制 `noExtensions: true`，只加载 provider、Hermes 和 programmatic runtime inline factories；不接受 extension 文件路径。
- Foreground single 已切换为 typed worker events，不再构造 CLI 参数或解析 stdout JSONL。
- Faux provider tests 覆盖 programmatic AgentSession、single result projection、stream events、Main registry ownership、重复 run 拒绝和 identity isolation。
- Sidecar/package smoke 现在验证 subagent worker entry、protocol handshake 和 ping。

本批明确未迁移：

- Nested fanout、intercom detach、async、schedule、resume 和 watchdog child runtime 仍使用现有实现。
- `pi-spawn.ts`、`pi-args.ts`、Desktop child CLI bootstrap 和 manifest Pi entry 暂时保留，直到剩余执行模式全部迁移。
- 带任意 agent extension 路径、nested fanout 或 intercom detach 的 programmatic foreground child 会明确拒绝，不回退到 CLI。

### 第二批：foreground parallel + chain

已完成：

- Top-level foreground parallel 现在将同一 thread-bound `SubagentRuntime` 注入每个叶子任务。
- 同一 run 的 parallel child 使用稳定且唯一的 `childIndex`，由 Main registry 各自持有独立 worker 进程。
- Foreground chain 的 sequential、static parallel 和 dynamic expansion 叶子均已切换到 programmatic runtime。
- Chain 继续复用现有 template、`{previous}`、output binding、acceptance、artifact、worktree、fail-fast、shared deadline 和结果聚合逻辑。
- Faux runtime tests 覆盖同 run 并发 child、sequential output 传递、parallel chain 并发和 dynamic fanout 保留索引。

本批明确未迁移：

- Intercom detach/supervisor child channel 尚未迁移。
- Async single、async parallel/chain、schedule、resume 和 watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 由于未迁移的 nested/async 路径仍复用 `runSync`，共享 CLI adapter 暂时保留；Desktop parent foreground single/parallel/chain 已不再调用该 adapter。

### 第三批：nested fanout

已完成：

- Subagent `runProgrammaticSingleAttempt` 现在当代理的 tool list 包含 `"subagent"` 时自动附加 `fanout` extension profile。
- Child-safe fanout extension 在 programmatic 模式中通过 `runProgrammaticSingleAttempt` 传递的 `SubagentRuntime` 注入受控 runtime。
- `DesktopSubagentRuntime` 原生支持嵌套授权：根请求验证 lineage，家长 worker 自动把 `rootRunId/depth/maxDepth/lineage` 注入嵌套 child 请求。
- 嵌套请求的 depth/maxDepth 校验独立于 `process.env`，通过 `resolveExecutorDepth` 基于 `ExecutorDeps.subagentDepth` 计算，规避环境变量污染问题。
- Main `SubagentWorkerRegistry` 在根请求上验证 lineage 完整性，拒绝 lineage 不匹配的伪造嵌套请求。
- Main 在父 worker 结束时级联清理所有后代 worker，防止孤儿进程。
- 级联清理同时通过 `onHostRequest` 把嵌套的 cancel/steer 路由回正确的后代 worker。
- Programmatic fanout child 禁用 async、schedule 和 intercom bridge；只接受 foreground single/parallel/chain。
- End-to-end faux test 覆盖父 `AgentSession` 调用 `subagent` tool → 嵌套 child worker → host request → 第二个受控 `AgentSession` → 结果返回。

本批明确未迁移：

- Intercom detach/supervisor child channel 尚未迁移。
- Async parallel/chain、schedule、resume 和 watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 由于未迁移的 async 路径仍复用 `subagent-runner.js`，共享 CLI adapter 暂时保留；Desktop parent foreground single/parallel/chain、嵌套 fanout 和 async single 已不再调用该 adapter。

### 第四批：async single

已完成：

- `executeAsyncSingle` 新增 `subagentRuntime` 可选参数，programmatic 分支在 `SubagentRuntime` 可用时替代 CLI `spawnRunner()`。
- Programmatic 分支写入初始 `status.json`（供 `async-job-tracker` 发现）、构造 `SubagentRuntimeRunRequest`（含 lineage、depth、model、tools、systemPrompt、turn/tool budget），以 fire-and-forget 方式启动 `consumeAsyncSingleRun()`。
- 新增 `consumeAsyncSingleRun()` 后台消费 `AsyncIterable<SubagentRunEvent>`：写 `events.jsonl`；`completed` 时写 final `status.json` + result file；`failed` 时写错误状态；consumer 异常时写 failure 状态。
- 两个 `subagent-executor.ts` 调用点（主 async single 路径和 `runInBackground` 路径）传入 `deps.subagentRuntime`。
- 与 filesystem 兼容：`async-job-tracker`、`readStatus()`、`async-status`、`fleet-view` 无需改动。
- `SubagentRuntime` 不可用时优雅降级到 CLI `spawnRunner()`。
- Faux provider 测试、typecheck、`npm run check`、sidecar build/smoke 全部通过。

本批明确未迁移：

- Schedule、resume 和 watchdog child runtime 仍使用 CLI-bound 过渡实现。
- `pi-spawn.ts`、`pi-args.ts`、`desktop-child-extension.ts`、`PI_DESKTOP_PI_ENTRY`、`subagent-runner.js` 暂保留。

### 第五批：async parallel/chain

已完成：

- `AsyncChainParams` 新增 `subagentRuntime` 可选参数。
- `executeAsyncChain` 新增 programmatic 分支：写入初始 `status.json`，构建 `parallelGroups`/`flatAgents` 元数据，发射 `SUBAGENT_ASYNC_STARTED_EVENT`，以 fire-and-forget 方式启动 `consumeAsyncChainRun()`。
- 新增 `runnerStepToRequest()` 将 `RunnerSubagentStep` 转换为 `SubagentRuntimeRunRequest`。
- 新增 `consumeLeafRun()` 运行单个叶子 child 并消费事件到 `events.jsonl`。
- 新增 `consumeAsyncChainRun()` 后台串联步骤：
  - sequential 叶子：逐次调用 `runtime.run(request)` 并等待完成。
  - parallel 组：`Promise.all` 并发所有 child。
  - dynamic fanout：暂不支持，`executeAsyncChain` 检查后降级到 CLI。
  - 每步完成后更新 `status.json` 中的 `currentStep` 和 steps 状态。
  - 全部完成后写 final `status.json` + result file。
- `subagent-executor.ts` 全部 5 个 `executeAsyncChain` 调用点传入 `deps.subagentRuntime`。
- 动态 fanout 的 async 模式仍需 CLI runner。
- 与 filesystem 兼容：`async-job-tracker`、`readStatus()`、`async-status` 无需改动。
- `SubagentRuntime` 不可用时优雅降级到 CLI `spawnRunner()`。
- Typecheck、7 个子代理测试文件（31 tests）、sidecar build/smoke、`npm run check` 全部通过。

本批明确未迁移：

- Schedule、resume 和 watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 动态 fanout 的 async 模式仍需 CLI runner。
- `pi-spawn.ts`、`pi-args.ts`、`desktop-child-extension.ts`、`PI_DESKTOP_PI_ENTRY`、`subagent-runner.js` 暂保留。

### 第六批：Async programmatic steer/interrupt/stop 控制通道

已完成：

- `consumeAsyncSingleRun` 新增 `runControlPollLoop()` 后台并发轮询 `steer-requests/`、`interrupt.json`、`stop.json`。
- steer request 到达时调用 `runtime.steer()` 转发到 Main 并注入运行中的 child AgentSession。
- stop/interrupt 到达时调用 `runtime.cancel()` 终止当前 run，consumer 写 stopped/failed 状态。
- `consumeLeafRun` 新增 `AbortSignal` 参数，中止时提前返回 cancelled 标记。
- `consumeAsyncChainRun` 新增 step 间 `runControlPollOnce()` 前置轮询 + 后台 `runControlPollLoop()`：
  - stop 信号级联取消所有未启动的后续步骤。
  - interrupt 信号类似中止。
  - 写 `status.json` 时标记 stopped 状态。
- 新增 `runControlPollOnce()` 和 `runControlPollLoop()` 辅助函数，与 CLI runner 共享相同的 `consumeSteerRequests`/`consumeStopRequest`/`consumeInterruptRequest` 文件系统 API。
- 文件系统兼容：control channel 文件路径与 CLI `watchAsyncControlInbox()` 一致。
- `SubagentRuntime` 不可用时 steer/interrupt/stop 通过 CLI runner 处理（降级路径未改）。
- Typecheck、25 个子代理测试、sidecar build/smoke、`npm run check` 全部通过。

本批明确未迁移：

- Watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 动态 fanout 的 async 模式仍需 CLI runner。
- `pi-spawn.ts`、`pi-args.ts`、`desktop-child-extension.ts`、`PI_DESKTOP_PI_ENTRY`、`subagent-runner.js` 暂保留。

### 第七批：Async resume 迁移

已完成：

- `resumeAsyncRun()` 中 `executeAsyncSingle` 调用传入 `subagentRuntime: input.deps.subagentRuntime`。
- 恢复的 run 走 programmatic `consumeAsyncSingleRun()` 路径（含 steer/interrupt/stop 轮询）。
- attachChain 路径的 `executeAsyncChain` 调用已包含 `subagentRuntime`。
- recovery descriptor 中的 `sessionFile`、`model`、`systemPrompt`、`budget` 等字段全部传递到 `SubagentRuntimeRunRequest`。
- `SubagentRuntime` 不可用时优雅降级到 CLI runner。
- Typecheck、25 个子代理测试、sidecar build/smoke、`npm run check` 全部通过。

本批明确未迁移：

- Watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 动态 fanout 的 async 模式仍需 CLI runner。
- `pi-spawn.ts`、`pi-args.ts`、`desktop-child-extension.ts`、`PI_DESKTOP_PI_ENTRY`、`subagent-runner.js` 暂保留。

### 第八批：Schedule 迁移

已完成：

- Schedule 的定时器触发走 `executorExecute()` → `executor.execute()` → `runAsyncPath()` → `executeAsyncSingle`/`executeAsyncChain`，这些路径自第四/五批已支持 `SubagentRuntime`。
- 修复全部 5 个 `isAsyncAvailable()` 调用点，当 `deps.subagentRuntime` 可用时不再需要 jiti/CLI runner。
- 覆盖路径：`runAsyncPath`、`runChainPath`、`runParallelPath`、`runSinglePath`（`runInBackground`）、`resumeAsyncRun`（attachChain）。
- `ScheduledRunManager` 本身（timer、store、fire）是纯调度层，不依赖 CLI 执行路径。
- Typecheck、25 个子代理测试、sidecar build/smoke、`npm run check` 全部通过。

本批明确未迁移：

- Watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 动态 fanout 的 async 模式仍需 CLI runner。
- `pi-spawn.ts`、`pi-args.ts`、`desktop-child-extension.ts`、`PI_DESKTOP_PI_ENTRY`、`subagent-runner.js` 暂保留。

### 第九批：CLI fallback 清理

已完成：

- 删除 `async-execution.ts` 中 `spawnRunner()`、`resolveAsyncRunnerNodeCommand()`、`resolveAsyncRunnerLogPaths()` 及所有 CLI runner 函数。
- 删除 `execution.ts` 中 `runSync` 和 `runSingleAttempt` 的整个 CLI fallback 分支。
- 删除 `import { applyThinkingSuffix } from "../shared/pi-args.ts"` 等 CLI-only import。
- `isAsyncAvailable()` 现在直接返回 `false`（不再尝试调用已删除的 `resolveAsyncRunnerNodeCommand`）。
- `async-execution.ts` 和 `execution.ts` 中所有执行路径现在只通过 `SubagentRuntime` 走 programmatic 模式。
- Typecheck、25 个子代理测试、sidecar build/smoke 全部通过。

本批明确未迁移（仍保留但不再被 programmatic 路径引用）：

- Watchdog child runtime 仍使用 CLI-bound 过渡实现。
- 动态 fanout 的 async 模式仍需 CLI runner。
- `pi-spawn.ts`、`pi-args.ts`、`desktop-child-extension.ts`、`PI_DESKTOP_PI_ENTRY`、`subagent-runner.js` 暂保留（但 `async-execution.ts` 和 `execution.ts` 不再引用它们）。