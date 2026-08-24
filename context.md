# Code Context

## Files Retrieved
1. `packages/desktop/src/sidecar/pi-rpc-session-runtime.ts` (lines 39-188, 213-261, 371-438, 579-641) - runtime 身份固定、RPC 调用与 identity-change 失败点。
2. `packages/coding-agent/src/modes/rpc/rpc-mode.ts` (lines 446-461, 599-619) - 上游只读依据：`fork` 后调用 `rebindSession()`，`get_state` 返回新 `sessionId/sessionFile`。
3. `packages/coding-agent/src/modes/rpc/rpc-types.ts` (lines 58-64) - 公共 RPC 命令形状：`{ type: "fork"; entryId: string }`。
4. `packages/desktop/src/sidecar/thread-worker-service.ts` (lines 12-84) - thread sidecar command 分派与 `session-materialized`/bootstrap 模式。
5. `packages/desktop/src/shared/sidecar-contracts.ts` (lines 1-38, 132-182, 204-247) - worker binding、sidecar event/command/result contracts。
6. `packages/desktop/src/main/sidecar/thread-worker-registry.ts` (lines 98-236, 394-475, 630-875) - create、remove、spawn、退役、metadata upsert、event 注册的可复用实现。
7. `packages/desktop/src/main/pi/session-supervisor.ts` (lines 1-151) - renderer IPC 到 registry 的 facade 与 attachment lease。
8. `packages/desktop/src/main/ipc.ts` (lines 419-489) - sessions IPC handler 模式。
9. `packages/desktop/src/shared/channels.ts` (lines 15-48) - sessions channel 声明模式。
10. `packages/desktop/src/shared/desktop-api.ts` (lines 130-180) - renderer 暴露的 `sessions` API contract。
11. `packages/desktop/src/preload/index.ts` (lines 245-333) - preload invoke、attach 缓冲与现有 create/remove API 模式。
12. `packages/desktop/src/shared/contracts.ts` (lines 395-449) - `SessionBootstrap`、identity、attachment、push contracts。
13. `packages/desktop/src/renderer/src/app/routes/_chat.projects.$projectId.session.$threadId.tsx` (lines 1-103) - 新 thread 路由校验、cache activate/ensure。
14. `packages/desktop/src/renderer/src/components/new-session-surface.tsx` (lines 24-174) - create 后 catalog 写入、cache materialize、导航模式。
15. `packages/desktop/src/renderer/src/state/session-cache-context.tsx` (lines 8-35, 113-208) - cache ensure/activate/retire 与旧 attachment 退役。
16. `packages/desktop/src/renderer/src/runtime/pi-session-store.ts` (lines 8-130) - 每 thread 的 `composerDraft` store，可在导航前预填。

## Key Code

### 已确认的身份变化
上游 `packages/coding-agent/src/modes/rpc/rpc-mode.ts:609-615`：
```ts
case "fork": {
  const result = await runtimeHost.fork(command.entryId);
  if (!result.cancelled) {
    await rebindSession();
  }
  return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
}
```
这意味着请求返回时，同一个 Pi RPC client 已不再代表源 thread。Desktop 当前 `PiRpcSessionRuntime.id` 是 `readonly`（`pi-rpc-session-runtime.ts:69-75`），所有 bootstrap/push/control 都继续使用该旧 id；随后 refresh 在 `pi-rpc-session-runtime.ts:404-412` 明确抛出：
```ts
throw new Error(`Pi RPC session identity changed: expected ${this.id}, got ${state.sessionId}`);
```

### 建议的最小 contract
在 `packages/desktop/src/shared/contracts.ts` 增加明确的应用层输入/结果，不把 RPC 原始结果泄漏到 renderer：
```ts
interface SessionForkInput {
  projectId: string;
  threadId: string;
  entryId: string;
}

interface SessionForkResult {
  cancelled: boolean;
  target?: { projectId: string; threadId: string };
  composerText?: string;
  bootstrap?: SessionBootstrap;
}
```
推荐成功时始终返回 `target + composerText + bootstrap`。`bootstrap` 使 renderer 可立即写 catalog/cache，避免导航先于 metadata catalog 可见；`composerText` 来自 Pi fork response 的 `text`，用于预填而不是自动发送。

### runtime 边界
在 `PiRpcSessionRuntime` 增加一次性 `fork(entryId)`：
1. 先断言 idle（或依赖 RPC 拒绝，但 Desktop 应给稳定错误）。
2. `client.request({ type: "fork", entryId })`。
3. cancelled 时保持旧 runtime，返回 cancelled。
4. 成功后立即 `requestState(client)`、`get_entries`、context/thinking levels，验证新 `sessionId !== this.id` 且有 `sessionFile`。
5. 返回新 session 的结构化 handoff（identity/path/text/bootstrap 或足以构造 bootstrap 的 snapshot），并把 runtime 标记为不可再接收旧身份命令/push。

不要简单把 `id` 改成可变字段：`timelineStore`、summary、已排队 refresh、sequence/events、host requests、浏览器 capability、main attachment 都绑定旧 identity，原地重置极易把新 session event 推到旧 renderer。

### registry 原子迁移
在 `ThreadWorkerRegistry` 增加 `fork(input)`，复用现有 `withThreadLock/use` 的 in-flight 纪律，但成功路径必须是特殊 handoff：
1. 锁定源 `workerKey`，确认 record 可用、idle、无并发 mutation。
2. 调 sidecar `{ type: "fork", entryId }`，取得新 id/path/text/bootstrap。
3. 验证新 key 不等于旧 key、catalog/records 中无冲突。
4. 将源 record `retired = true`，从旧 key 删除；调用 `awaitRecordShutdown(record)`，撤销旧浏览器 capability 并终止已 rebind 的进程。现成实现见 `thread-worker-registry.ts:678-708,801-823`。
5. 用新 path/summary 调 `metadata.upsert(...)`；然后按 `open(projectId,newId)`/`spawn(open binding)` 注册新 worker。现成 create 的 bootstrap 校验和 `records.set` 模式见 `thread-worker-registry.ts:183-236`，spawn 冲突防护见 `630-665`。
6. 返回新 bootstrap 和 composer text；触发 catalogChanged，源 thread 本身不删除，后续 attach 会从原 session file 重开。

需要同时考虑 old/new 两个 key 的排序锁。只持旧锁后写新 key，会和并发 attach/new metadata discovery 竞态；可先由 runtime 得到新 id，再进入按 key 排序的双锁提交阶段，并在提交前 CAS 检查源 record 仍是当前 generation。未知结果错误沿用 `retireAfterUnknown`：fork 是 mutation，不可自动重放。

### metadata 注册
成功 fork 后不能只等 `list()` 扫描：renderer 路由在 `...session.$threadId.tsx:42-70` 会先校验 catalog，未发现新 id 会判 invalid。应在 registry 返回前完成：
- 新 session path + summary 的 `metadata.upsert`；
- `catalogChanged(newThread)` 或让 renderer 通过 bootstrap dispatch `thread-catalog-added`；
- 新 `Thread` 的 `parentThreadId=sourceId`、`origin="branch"` 必须由权威 metadata/session header 投影保留，避免 runtime summary 覆盖。registry 现有 `parentThreadId` overlay 在 `thread-worker-registry.ts:837-841` 可复用，但 fork handoff 必须初始化该字段。

### renderer 导航与 composer 预填
复用 `NewSessionSurface` 的顺序：先写 catalog/cache，再 navigate（`new-session-surface.tsx:143-174` 与 `49-54`）。建议消息编辑提交 handler：
1. `await window.desktop.sessions.fork({ projectId, threadId, entryId })`。
2. cancelled 则保持当前编辑态。
3. `dispatchDesktop(..., { type: "thread-catalog-added", bootstrap })`。
4. `const record = sessionCache.ensure(target)`，在导航前调用 `record.stores.composerDraft.setSnapshot({ text: composerText, attachments: [] })`。
5. `navigate({ to: "/projects/$projectId/session/$threadId", params: target })`。

`use-pi-session-runtime.ts` 已从 `composerDraft` 恢复 composer 文本，因此无需把 prefill 放 route search，也无需新增全局临时状态。路由 query 会暴露/持久化长文本并产生刷新语义问题。旧 session cache 不应 retire：fork 不删除源 session；但其 attachment 指向已退役 generation，registry/supervisor 必须发 availability/resync 或 renderer 主动 detach，使旧 route 下次 attach 重开源文件。

### 应修改的边界（实施时）
- `packages/desktop/src/shared/contracts.ts`: `SessionForkInput/Result`。
- `packages/desktop/src/shared/sidecar-contracts.ts`: `ThreadSidecarCommand` 加 `fork`，result union 加 fork handoff；递增 `SIDECAR_PROTOCOL_VERSION`。
- `packages/desktop/src/sidecar/pi-rpc-session-runtime.ts`: 一次性 fork/handoff 和成功后封禁旧 runtime。
- `packages/desktop/src/sidecar/thread-worker-service.ts`: fork command 分派。
- `packages/desktop/src/main/sidecar/thread-worker-registry.ts`: 双 identity 提交、旧 worker 退役、新 metadata/worker 注册。
- `packages/desktop/src/main/pi/session-supervisor.ts`: `fork` facade，并处理旧 identity subscriptions 的 generation 失效/resync。
- `packages/desktop/src/shared/channels.ts`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/shared/desktop-api.ts`, `packages/desktop/src/preload/index.ts`: `sessionsFork` IPC 全链路。
- renderer 的 user-message edit action/runtime adapter：把现有“更新”发送行为改接 fork（具体 action 入口需实现阶段继续追踪 assistant-ui adapter），写 catalog、预填 `composerDraft`、导航。

## Architecture
`renderer -> preload DesktopApi -> main ipc -> SessionSupervisor -> ThreadWorkerRegistry -> thread sidecar -> PiRpcSessionRuntime -> Pi RPC`。fork 的关键不是普通 command 增量，而是 RPC 进程身份发生置换。身份所有权应留在 registry：sidecar 只返回经验证的新 session handoff；registry 原子退役旧 generation、持久化新 metadata、注册新 generation；renderer 只消费稳定的 `SessionForkResult`。

现有可复用模式：
- create：reservation、spawn、bootstrap identity 校验、catalog dispatch、导航。
- remove/restart：`retired` 标记、记录 CAS 删除、`awaitRecordShutdown`、浏览器 capability revoke。
- route：catalog 校验后 `cache.activate/ensure`。
- composer：per-thread `composerDraft` 持久 store。

## Review Findings
- **blocker** `packages/desktop/src/sidecar/pi-rpc-session-runtime.ts:69-75,404-412` - 当前 runtime 假设 session identity 永不变化；直接发送 fork 后必然进入 identity-change error，且可能在错误前把新 session 原子事件标成旧 threadId 推送。
- **high** `packages/desktop/src/main/sidecar/thread-worker-registry.ts:826-866` - event handler 完全信任 record 的旧 `threadId`；fork 成功后的 sidecar event/summary/materialized 没有 identity migration 协议，存在跨 thread 污染。
- **high** `packages/desktop/src/main/pi/session-supervisor.ts:87-151` - attachment lease 以旧 identity 固定；worker rebind 后若不失效旧 subscription，新事件会投递旧 renderer。
- **high** `packages/desktop/src/renderer/src/app/routes/_chat.projects.$projectId.session.$threadId.tsx:42-70` - 导航前若 catalog 未加入新 thread，路由会判 invalid；metadata 最终扫描不够可靠。
- **medium** `packages/desktop/src/main/sidecar/thread-worker-registry.ts:630-665` - 新 identity 注册有冲突检查，但 fork 需要 old/new 双 key 锁和 generation CAS，单 key `use()` 不足。
- **medium** `packages/desktop/src/main/sidecar/thread-worker-registry.ts:801-823` - 浏览器 identity/token 固定在源 thread；继续复用 rebind worker 会让 capability identity 错配，支持“成功后关旧 worker、以新 binding 重开”的方案。

## Residual Risks
- Pi `fork` response 与 `get_state/get_entries` 之间仍可能有扩展事件；runtime 必须隔离或缓冲成功后的事件，不能按旧 id emit。
- fork 命令是不可幂等 mutation；IPC/sidecar 断线后的 unknown outcome 只能退役并刷新 catalog，不能自动重试。
- 新 session header 中 parent/origin 的实际 metadata 投影需在实施前核对 metadata worker projector；不能仅在 renderer 伪造关系。
- fork 成功但新 worker 启动失败时，新 session 已持久化。API 应返回可恢复错误并刷新 catalog，不能删除 session 或回滚 Pi fork。
- composer prefill 只建议承载文本；原消息图片/引用是否复制需要产品决策，Pi fork RPC 当前只返回 `text`。

## Start Here
先打开 `packages/desktop/src/sidecar/pi-rpc-session-runtime.ts` 的 `PiRpcSessionRuntime` 与 `scheduleRefresh()`。先定义“fork 成功后 runtime 不再代表旧 identity”的一次性 handoff 边界，再向外扩展 sidecar/registry/IPC；否则上层无论如何 rekey 都无法避免旧事件污染。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "context.md 包含 6 条带 severity 和精确文件/行号的 review findings，并列出完整调用链、contracts/API/IPC 修改面及 residual risks"
    }
  ],
  "changedFiles": [
    "/Users/tanliuyi/projects/meta-agent-v2/context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "只读 find/grep/read 检查 Desktop 与上游 Pi RPC 源码",
      "result": "passed",
      "summary": "确认 fork 后 rebindSession、Desktop 固定 identity 约束及 create/remove/route/composer 可复用模式"
    }
  ],
  "validationOutput": [
    "确认上游 fork 成功后同一 RPC client 切换 session identity",
    "确认 Desktop 当前 scheduleRefresh 对 identity change 明确报错",
    "确认 renderer route 在导航前要求新 thread 已进入 catalog"
  ],
  "residualRisks": [
    "fork 后早到 RPC events 必须隔离，避免按旧 threadId 推送",
    "unknown outcome 不可重放，只能退役 generation 并刷新 catalog",
    "parent/origin 权威 metadata 投影仍需实施阶段核对"
  ],
  "noStagedFiles": true,
  "diffSummary": "仅写入要求的只读分析产物 context.md；未修改产品代码",
  "reviewFindings": [
    "blocker: packages/desktop/src/sidecar/pi-rpc-session-runtime.ts:69 - runtime identity 固定，fork 后必然失配且可能污染旧 thread 推送",
    "high: packages/desktop/src/main/sidecar/thread-worker-registry.ts:826 - registry 缺少 worker identity migration/retirement 协议",
    "high: packages/desktop/src/main/pi/session-supervisor.ts:87 - 旧 attachment lease 不会因 fork 自动失效",
    "high: packages/desktop/src/renderer/src/app/routes/_chat.projects.$projectId.session.$threadId.tsx:42 - catalog 未预注册会导致新 thread 路由 invalid"
  ],
  "manualNotes": "分析严格只读产品源码；context.md 是任务指定交付物。"
}
```
