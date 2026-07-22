# Desktop Session 路由与 Runtime 缓存规范

状态：Proposed
最后更新：2026-07-21

本版已将 per-window 单 active attachment 模型重写为多 attachment 架构：每个 cached session 持独立 attachment lease，inactive session 持续接收 push。`ActiveSessionTransport`/串行队列/单 attachment 不变量已由 `SessionTransportManager`/per-key serialized attach/多 lease 不变量替代。

## 1. 摘要

Desktop 使用 TanStack Router 将真实 Pi session 表达为稳定 URL：

```text
/projects/$projectId/session/$threadId
```

路由是 active session identity 的唯一导航来源。切换 session 时，旧 session 不因离开路由而卸载；已访问 session 由窗口级 cache host 保留其 React state、assistant-ui runtime、Composer、消息投影和 session UI DOM。当前路由只决定哪个缓存单元可见；每个 cached session 持有独立 IPC attachment，并在 hidden 时继续接收 timeline/control push。

目标结构：

```text
AppProviders
  -> DesktopCatalogProvider (lazy)
  -> SessionCacheProvider
       -> SessionTransportManager
  -> Router
       -> RootRouteHost
            -> SessionCacheHost
                 -> Activity(session A, hidden)
                      -> SessionProvider A
                           -> AssistantRuntimeProvider(runtime A)
                           -> SessionSurface A
                 -> Activity(session B, visible)
                      -> SessionProvider B
                           -> AssistantRuntimeProvider(runtime B)
                           -> SessionSurface B
            -> DesktopShell / Settings routes
```

本规范的核心约束：

1. 每个缓存 session 独立持有一个 assistant-ui runtime。
2. `SessionCacheProvider` 持有 session record 与缓存生命周期，不直接调用 React runtime hook。
3. `SessionTransportManager` 是 renderer 唯一 IPC attachment API 所有者，并为每个 cached session 管理独立 attachment lease。
4. 同一 session record 最多有一个 committed attachment；不同 record 的 attachment 可以并存并持续接收 push。
5. TanStack Router 只管理 URL、active identity、前进后退和 route error，不承担 React DOM keep-alive 或 transport 生命周期。
6. session route 切换本身不得销毁旧 session state 或 detach 旧 session。
7. Pi session、timeline 和 JSONL 仍是业务权威；renderer cache 只是窗口内 UI/runtime 投影。

## 2. 与现有规范的关系

### 2.1 本规范替代的范围

本规范替代以下既有约束：

- [Desktop Renderer 架构规范](./renderer-architecture.md)中“renderer 只保留 active `SessionBootstrap`”、“active session key 重建 session-scoped Panel/Terminal”以及“settings route 不挂载任何 Desktop provider”的约束；
- [Desktop Pi-native assistant-ui External Store Runtime 规范](./pi-native-assistant-ui-runtime-spec.md)中窗口级单一 `useExternalStoreRuntime()`、单一 `PiThreadStore` 和 assistant-ui thread-list adapter 负责 session 切换的约束；
- [Desktop assistant-ui ThreadList Primitives 集成规范](./assistant-ui-thread-list-primitives-spec.md)中 Sidebar 必须位于同一个 `AssistantRuntimeProvider` 下、必须通过 `AssistantRuntime.threads` 切换 session，以及“不为 session 创建独立 runtime”的约束。

旧文档中的 Pi-native timeline 数据模型、Project 分组、CRUD 最终结果和底层错误隔离继续有效。旧文档定义的单 active attachment、active selection、runtime/thread adapter 调用路径、draft materialize 后的导航提交、Sidebar primitive 上下文和 provider 生命周期不再有效，统一由本规范定义。

### 2.2 继续有效的约束

以下约束不变：

- [Desktop Node Sidecar 规范](./node-sidecar-per-thread-spec.md)中的每个 live thread 一个 sidecar worker；
- attach token、bootstrap、pending push buffer、ACK、generation 和 stale result 隔离，但全部改为 per-attachment lease；
- Pi-native `PiThreadSnapshot` / `PiThreadEventBatch` 是消息数据面；
- Pi session、SessionManager 和 JSONL 是持久化权威；
- renderer-only draft 只在首次有效提交时创建真实 Pi session；
- Project catalog、thread catalog、主题和窗口布局是窗口级状态；
- Workbench 的持久化字段仍通过 main 读写；
- rename、archive、delete 和 Project remove 仍由 Desktop controller 统一编排。

### 2.3 规范优先级

本规范改变 renderer 导航/runtime/cache 所有权，并明确替代 main/preload 的“每窗口单 active attachment”基数。main/preload 必须支持每个 renderer window 同时持有多个 session attachment，但不修改 Pi 公共 API、JSONL schema、sidecar wire protocol 或 session command 语义。

[Desktop assistant-ui Thread Adapter 与原子 Attach 规范](./assistant-ui-thread-attach-spec.md)、[Desktop Pi-native assistant-ui External Store Runtime 规范](./pi-native-assistant-ui-runtime-spec.md)及其他旧文档中的单 attachment 描述均由本规范替代。实现时必须同步更新这些文档的 supersession 状态，不得让两套基数约束同时生效。

## 3. 目标

1. 每个真实 session 有可复制、可恢复、可前进后退的稳定 URL。
2. Sidebar thread 激活通过 Router navigation 完成，不再由 `runtime.threads.switchToThread()` 完成。
3. A -> B -> A 切换后，A 的 assistant-ui runtime、Composer、滚动位置、折叠状态和 session UI state 保持。
4. session route 切换不重建已经缓存的 `AssistantRuntimeProvider`。
5. 每个缓存 session 的 timeline、message repository、command coordinator 和 attachment lease 互相隔离。
6. 同一窗口可以为多个 cached sessions 同时持有 attachment；同一 session key 最多一个 committed attachment。
7. inactive cached session 持续接收 timeline/control push，其 record 与 Sidebar 摘要保持实时。
8. cold deep link 可以直接恢复指定 Project/session，不依赖窗口内 `activeThreadIds`。
9. settings、draft、删除、归档、恢复、Project remove 和 attach failure 有明确路由语义。
10. route preload 不触发 Project open、session attach 或其他有副作用命令。
11. 每个 attachment 独立执行 bootstrap buffer、flush、ACK、背压和 resync；一个 attachment 故障不得阻塞其他 cached sessions。

## 4. 非目标

本规范不要求：

- 未进入 cache 的所有 catalog sessions 都建立 attachment；
- inactive session 可发送 prompt/edit/reload 等 mutation command；
- session DOM 或 Composer 跨应用重启持久化；
- Assistant Cloud、RemoteThreadListRuntime 或 HTTP transport；
- 修改 Pi session JSONL；
- 在 URL 中保存完整 Workbench、Composer 或模型状态；
- 跨窗口共享 session cache；
- 首期引入自动 LRU 淘汰；
- 让 assistant-ui thread-list runtime 成为导航或 catalog 权威。

## 5. 术语

### 5.1 Route identity

由 `{ projectId, threadId }` 构成的真实 session identity。它是 active session 的导航真相。

### 5.2 Session key

renderer 内部使用无歧义编码得到的 cache key。必须通过结构化 helper 创建和解析，不允许业务组件自行拼接或切片。

```ts
interface SessionIdentity {
  projectId: string;
  threadId: string;
}
```

现有 `projectId:threadId` 字符串只能继续作为 reducer cache key；Router params 和 transport identity 不得依赖冒号可安全分隔。

### 5.3 Cached session record

窗口内一个已访问 session 的长期 record。它持有可脱离 React effect 生命周期存在的 external stores 与摘要。

### 5.4 Session activity

一个由 React `Activity` 包裹的 session React subtree。`visible` 表示当前 session，`hidden` 表示保留 state/DOM 但不作为当前交互表面。

### 5.5 Attachment lease

一次 cache record 与 main subscription 之间的有界连接，由 opaque `attachmentId`、session identity 和 record generation 标识。`flush`、`detach`、ACK 和 replace/resync 必须携带该 lease token，禁止使用“当前 attachment”式全局操作。

### 5.6 Session transport manager

窗口内唯一允许调用 preload session attachment API 的 renderer 模块。它由 cache record 生命周期驱动，为每个 record 管理独立 lease；Router 只决定哪个已缓存 record 可发送用户命令，不决定其他 record 是否继续接收 push。

## 6. 路由设计

### 6.1 Route tree

目标 route tree：

```text
__root
  /
  /new
  /projects/$projectId/session/$threadId
  /settings
    /personalization
    /models
    /auth
```

建议文件：

```text
app/routes/index.tsx
app/routes/new.tsx
app/routes/projects.$projectId.session.$threadId.tsx
app/routes/settings.tsx
```

`route-tree.gen.ts` 继续由 `@tanstack/router-plugin` 生成，不得手工修改。

### 6.2 为什么 URL 必须包含 Project

只使用 `/session/$threadId` 会假设 thread ID 全局唯一，并要求 cold start 扫描所有 Project catalog 才能定位 session。当前 renderer、adapter 和 transport 都使用 `{ projectId, threadId }` 作为真实 identity，因此规范 URL 必须同时携带两者。

### 6.3 根路由

`/` 不是隐式 active-thread 页面。它只负责：

1. renderer 初始化 Project catalog；
2. 若窗口内有 last active route，则 `replace` 到该 route；
3. 否则读取 main 的 active Project，并选择其第一个可用 regular session；
4. 没有 session 时进入 `/new?projectId=...` 或显示明确空状态。

cold start 不再通过 `activeThreadIds` 猜测 route。`activeThreadIds` 可以在迁移期作为窗口内最近访问摘要，最终不得成为导航来源。

### 6.4 Session route

session route 解析 params，并通过 lazy catalog validation 确认 Project 存在、thread 属于该 Project 且不是 archived，之后才 ensure 对应 cache record。record 创建会请求 `SessionTransportManager` 建立 attachment；校验过程可以在 URL commit 后由 session-scoped loading state 表达，但不得在 loader 中 attach session。不存在、Project 不匹配或 archived 的 identity 不得进入 cache 或成为 attachment target。

```ts
export const Route = createFileRoute(
  "/projects/$projectId/session/$threadId",
)({
  component: SessionRoute,
});
```

不得设置 session-param `remountDeps`。缓存单元的 React identity 由 `SessionCacheHost` 的 session key 管理，不由 route component remount 管理。

### 6.5 Draft route

`/new` 表示唯一 renderer-only draft。目标 Project 使用 typed search param：

```text
/new?projectId=<projectId>
```

继续遵守 [Desktop 新会话草稿规范](./new-session-draft-spec.md)，但 materialize 的 attachment 生命周期由 `SessionTransportManager` 管理，不再通过 `runtime.threads.switchToNewThread()`：

- draft 没有 thread ID；
- draft 不进入 session catalog；
- materialize 时，manager 获得唯一临时 materialization lease 创建 session 并 attach；
- materialize 成功后 `replace` 到真实 session route，materialization lease 转为普通 cache record lease；
- create/attach 或首条命令 `preflightResult(false)` 失败时，manager 释放临时 lease 并清理未提交 session，保留 draft record 和 Composer，停留 `/new`；
- 首期只允许一个 draft cache record。

materialization 泄漏后的 stale main subscription 由 `replaceAttachmentId` compare-and-swap 或 session/Project 级删除清理；renderer 不得依赖单个窗口的 route identity 推断哪次 attach 仍在进行中。

### 6.6 Settings route

进入 settings 时：

- 窗口级 `DesktopCatalogProvider`、`SessionCacheProvider` 和 `SessionTransportManager` 基础设施仍挂载；
- 已缓存 session activities 保留，但全部变为 hidden；
- 已缓存 session attachment 保留并继续接收 timeline/control push；
- catalog provider 使用 lazy initialization，cold start 直接进入 settings 时不得加载 Project/session catalog；
- settings 不创建新的 session record、runtime 或 attachment；
- 离开 settings 回到已缓存 session route 时恢复对应 Activity，不重复 attach；
- cold start 直接进入 settings 时，session cache 和 attachment map 保持为空。

这明确替代旧 renderer 规范中“settings route 完全不挂载 Desktop provider”的边界。新边界是“不因 settings 初始化新的 chat catalog/runtime/attachment”，而不是 detach 已有 cache 或不挂载轻量 provider 基础设施。

### 6.7 Link 与 preload

Sidebar 使用 TanStack Router `Link` 或 typed `navigate()`：

```tsx
<Link
  to="/projects/$projectId/session/$threadId"
  params={{ projectId, threadId }}
/>
```

当前 Router 配置使用 `defaultPreload: "intent"`。因此：

- route loader/beforeLoad 不得调用 `projects.open()`；
- route loader/beforeLoad 不得调用 `sessions.attach()`、`sessions.create()` 或 `sessions.detach()`；
- hover/focus 预热只能调用无导航副作用的 `sessions.prewarm(projectId, threadId)`；
- preload failure 不得修改 active route、cache registry 或任何既有 attachment lease。

## 7. 所有权模型

### 7.1 窗口级所有者

窗口级 providers 持有：

- Project catalog；
- thread catalogs；
- theme、thinking visibility 和 layout preference；
- session cache registry；
- active route identity；
- per-record transport manager 与 attachment lease registry；
- 全局错误通知；
- cache summaries。

窗口级 provider 不持有某个 session 的 assistant-ui runtime。

### 7.2 Cache record 所有者

建议 record：

```ts
interface CachedSessionRecord {
  readonly key: string;
  readonly identity: SessionIdentity;
  readonly generation: number;
  readonly timeline: PiThreadStore;
  readonly control: SessionControlStore;
  readonly workbench: SessionWorkbenchStore;
  readonly summary: SessionSummaryStore;
  readonly connection: SessionConnectionStore;
  lastAccessedAt: number;
}
```

record 不保存由 React Hook 创建的 `AssistantRuntime`，也不直接暴露可变 attachment token。它保存 external runtime 所消费的稳定 store和可观察 connection state，使 Activity hidden、effect teardown 或 transport replace/resync 不会丢失领域投影。opaque lease 只由 `SessionTransportManager` registry 持有。

`SessionBootstrap` 必须提交到 identity、record generation 和 attachment request 都匹配的 record。禁止继续用一个全局 `bootstrap` 字段表示所有缓存 session。bootstrap 中的完整 timeline/control baseline 原子 replace 目标 record；只有明确标记的 renderer-only Composer/attachment/UI state 可以保留。

### 7.3 SessionProvider 所有者

每个缓存 activity 内有且只有一个 `SessionProvider`：

```tsx
function SessionProvider({ record, active, children }: SessionProviderProps) {
  const runtime = usePiSessionRuntime({ record, active });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
```

它持有：

- `useExternalStoreRuntime()` 返回的 `AssistantRuntime`；
- assistant-ui Composer state；
- message repository projection；
- queue adapter；
- attachment adapter；
- session command coordinator；
- session-scoped React context；
- 只与该 session UI 有关的 component-local state。

它不负责：

- 决定 active session；
- attach/flush/detach/resync renderer transport；
- 切换 thread；
- 管理 Project/thread catalog；
- 全局错误和 cache 淘汰。

### 7.4 SessionTransportManager 所有者

`SessionTransportManager` 位于所有 cached activities 外部，是唯一允许调用 `window.desktop.sessions.attach/flush/detach` 的 renderer 模块。其生命周期与 `SessionCacheProvider` 对齐，不归 Router component 或任一 `SessionProvider` effect 所有。

职责：

1. 订阅 cache registry 的 ensure、retire 和 materialize intent；
2. 为每个 session key 维护独立 record generation、connection state 和 attachment lease；
3. record 首次创建时 attach 对应 identity；不同 session key 可以并行 attach，同一 key 的 attach/replace/resync 必须串行且 single-flight；
4. 将 bootstrap 只提交到 identity、record generation 和 lease request 都匹配的 record；
5. 将后续 push 按 `attachmentId`、payload identity 和 record generation 分发到对应 record；
6. 对目标 record 完成 bootstrap hydrate 后，只 flush 对应 attachment 的 preload buffer；
7. record retire 时先 tombstone generation，再 detach 对应 lease，最后允许删除 stores/Activity；
8. attach settle 后重新验证 record 仍注册且未 tombstone；stale 结果不得 commit/flush，并只清理自己返回的 lease；
9. sequence gap、preload buffer overflow或 ACK timeout 时，只对对应 record 执行 serialized single-flight replace/resync；
10. 窗口销毁时 main 按 `webContents.id` 清理该窗口全部 leases。

`SessionProvider` hidden/visible effect 和 Router navigation 的执行顺序不得影响 attachment ownership。route switch 不 attach/detach 已存在的 record。

每个 session key 至少满足以下状态机：

```text
cache.ensure(identity, recordGeneration)
  -> absent: attach(identity, no previous lease)
  -> attaching: reuse the same in-flight promise
  -> ready: reuse committed lease
  -> error: explicit retry starts a new generation

attach settles
  -> record identity/generation still current: commit bootstrap + lease, then flush(attachmentId)
  -> stale or tombstoned: do not commit/flush; detach(returned attachmentId)

resync requested
  -> serialize behind that key's current attach
  -> attach(identity, replaceAttachmentId=current lease)
  -> atomically commit new bootstrap/lease, then flush(new attachmentId)
  -> detach/retire old lease through compare-and-swap replacement

cache.retire(key)
  -> tombstone record generation and disable commands
  -> detach(committed attachmentId) or invalidate in-flight request
  -> remove record only after ownership cleanup is scheduled
```

不同 key 不共享全局 attach generation，不得因 A 的 attach/resync 失败 detach B。实现可以限制全局并发数防止启动风暴，但不得把 route activation 恢复为单 active attachment。

## 8. React Activity 缓存

### 8.1 Cache host

`SessionCacheHost` 对所有已注册 record 渲染稳定 keyed activity：

```tsx
function CachedSessionActivity({ record, active }: Props) {
  return (
    <Activity
      name={record.key}
      mode={active ? "visible" : "hidden"}
    >
      <SessionProvider record={record} active={active}>
        <SessionSurface />
      </SessionProvider>
    </Activity>
  );
}
```

要求：

- `key` 只取稳定 session key；
- route 切换不得删除旧 record；
- 同一 key 不得同时存在两个 `SessionProvider`；
- active session activity 必须唯一；
- settings、root empty 和 draft route 下允许所有真实 session activities hidden。

### 8.2 Hidden 语义

React 19.2 `Activity mode="hidden"` 用于：

- 保留 React state；
- 保留可恢复 DOM；
- 暂停 hidden subtree 的 effects；
- 重新 visible 时恢复 effects。

因此 session 的长期领域数据必须位于 record external stores，不能只依赖 effect subscription 的瞬时对象。

禁止用以下方式替代：

- 仅依赖 TanStack Router match cache；
- route param `remountDeps`；
- 在 session 切换时给 provider 设置新 key；
- 只使用 CSS `display: none` 让所有 session effects 永久运行；
- 在每个 hidden `SessionProvider` 内重复注册 transport listener；attachment listener 必须集中在窗口级 manager。

### 8.3 Session surface 边界

缓存 activity 至少覆盖：

- Chat Thread 和 Messages；
- Composer；
- session Topbar controls；
- Workbench Panel；
- Bottom Terminal 容器；
- session dialogs、popover 和本地折叠状态。

Sidebar、Project tree、全局错误 toast、Node runtime gate 和 settings 不进入每个 session activity，避免为每个缓存 session 复制窗口级 DOM。

### 8.4 缓存移除

route switch 本身不得移除 record。首期只在以下情况卸载：

- session 被删除；
- Project 被移除；
- 应用窗口销毁；
- 不可恢复的 identity/schema 错误后用户确认清理；
- 显式 cache reset 开发命令。

首期不自动 LRU 淘汰。实现必须记录 cache entry 数和估算资源指标，为后续容量策略提供依据。未来引入 LRU 时必须另行定义保护条件，至少不能淘汰 active、running、Composer 非空或 materializing 的 entry。

## 9. assistant-ui Runtime 设计

### 9.1 从 multi-thread runtime 转为 per-session runtime

现有 `usePiRuntime()` 同时承担 active timeline、assistant-ui thread list、draft 和 thread switch。目标拆分为：

```text
usePiSessionRuntime(record, active)
  -> exactly one session message repository
  -> exactly one session composer
  -> exactly one command coordinator
  -> no thread-list adapter navigation

useDraftRuntime(draftRecord)
  -> renderer-only composer
  -> materialize command

SessionNavigation
  -> TanStack Router Link/navigate
```

真实 session runtime 不再调用：

- `runtime.threads.switchToThread()`；
- `runtime.threads.switchToNewThread()` 进行普通 session 导航；
- `ExternalStoreThreadListAdapter.onSwitchToThread()`；
- adapter composite ID 解析来定位 Project/thread。

### 9.2 Runtime identity

一个 `SessionProvider` 创建的 runtime 在 record 生命周期内必须稳定。A -> B -> A 后：

- A 的 runtime object 和内部 Composer state 保留；
- A 的 timeline store 使用 reattach bootstrap 更新；
- B 的 runtime 不接收 A 的 repository 或 control；
- Sidebar active 状态只由 Router params 决定。

### 9.3 Active capability

inactive cached runtime 继续接收 timeline/control push，但不是用户 mutation command target。其 adapter capability 必须关闭会产生 session mutation 的交互，且 Activity hidden surface 不可交互。

普通 command handler 在调用时必须同时校验：

```text
active route identity === record.identity
record connection state === "ready"
manager committed lease generation === record generation
```

不能只依赖 hidden DOM 不可点击，也不能把“仍在接收 push”等同于可发送命令。draft materialize 的首条命令是唯一例外，必须持有 11.4 定义的临时 materialization lease。

### 9.4 Composer 摘要

Sidebar 不能继续调用 active assistant-ui context 的 `useAuiState()`。每个 `SessionProvider` 将最小摘要写入 record summary store：

```ts
interface CachedSessionSummary {
  composerEmpty: boolean;
  running: boolean;
  loading: boolean;
  hasPendingAttachments: boolean;
  connectionState: "attaching" | "ready" | "recovering" | "error";
}
```

摘要只用于导航确认、running indicator 和 cache policy，不复制 Composer text、附件对象或消息正文。

### 9.5 Sidebar

Sidebar 改为 Router 驱动的普通 Project/session 导航：

- 列表来自 Desktop thread catalogs；
- active 来自 route params；
- open 使用 typed `Link`/`navigate()`；
- prewarm 保留无副作用 IPC；
- rename/archive/delete 继续调用 Desktop commands；
- 离开非空 draft 或 session Composer 前的确认读取 cache summary；
- 不再依赖 `ThreadListPrimitive.Items`、`ThreadListItemPrimitive.Trigger` 或 assistant-ui `mainThreadId` 完成导航。

如果保留 ThreadList primitive 的纯展示/ARIA 部分，必须证明它不要求一个覆盖整个 Sidebar 的 multi-thread runtime，且默认 action不会再次触发切换。否则应使用语义化 list、link 和现有菜单控件实现等价可访问性。

## 10. Transport 与数据一致性

### 10.1 多 attachment 不变量

任意时刻：

```text
committed attachment count per renderer window
  <= cached real-session record count
committed attachment count per session key per renderer window
  <= 1
main subscription identity
  = (webContentsId, attachmentId, projectId, threadId)
```

cache 中每个真实 session 可以有一个 attachment。draft 在 materialize 前没有 attachment；attach error、retiring record 或短暂 replace/resync 期间允许 record 没有 committed lease。实现不得为同一 record 保留两个同时接收 push 的 committed leases。

### 10.2 Preload 与 main API

全局无参 `sessions.flush()` / `sessions.detach()` 不适用于多 attachment，目标 API 必须显式携带 lease token：

```ts
interface SessionAttachmentLease {
  attachmentId: string;
  bootstrap: SessionBootstrap;
}

interface SessionAttachInput extends SessionIdentity {
  requestId: string;
  replaceAttachmentId?: string;
}

sessions.attach(
  input: SessionAttachInput,
  listener: (update: SessionPushPayload) => void,
): Promise<SessionAttachmentLease>;

sessions.flush(attachmentId: string): SessionFlushResult;
sessions.detach(attachmentId: string): void;
```

`replaceAttachmentId` 是 compare-and-swap token：main 只有在该 token 仍属于同一 `webContentsId` 和 session identity 时才原子替换；stale replace 不得删除较新的 lease。首次 attach 若同一 owner/session 已有 committed lease，main 必须拒绝重复 attach，不能静默创建第二个 subscription。

preload 使用 `Map<attachmentId, ActiveSessionAttachment>` 和按 `requestId/sessionKey` 隔离的 pending buffer，不再使用单一 `activeSessionAttachment` / `pendingSessionAttachment`。`flush` 只释放目标 token 的 buffer；buffer overflow 返回或推送 typed recovery result，使 manager 将对应 record 标记为 `recovering` 并执行 replace/resync，不能静默 detach 后仍显示 ready。

main 使用 `Map<webContentsId, Map<attachmentId, RendererSubscription>>`。窗口销毁时清理内层全部 subscriptions；session/Project 删除时只清理 identity 匹配的 subscriptions。

### 10.3 Cache activation 顺序

首次打开 B：

```text
Router commits target identity B
  -> catalog validation
  -> cache.ensure(B, generation)
  -> Activity B visible / A hidden
  -> SessionTransportManager starts attach(B)
  -> main prepares B bootstrap and registers B subscription
  -> manager verifies B record identity/generation is still current
  -> bootstrap atomically replaces record B timeline/control baseline
  -> B runtime reads hydrated external stores
  -> preload flushes only B attachment buffer
```

A record、Activity 和 attachment 均不被删除。A hidden runtime 继续接收 A push；只有 B 可通过普通 UI 发送 mutation command。若 B 已在 cache 且 lease ready，切换只改变 Activity visibility，不 attach 或 fresh bootstrap。

### 10.4 Bootstrap 与持续更新

首次 attach 或 replace/resync 的 fresh bootstrap 是该 Pi session 的当前权威基线。提交规则：

- timeline 使用 `PiThreadStore.replace()` 原子替换；
- control 作为完整权威 baseline replace，不用浅 merge 保留已删除的 host request、widget、model 或 command；
- Workbench 按持久化 revision/更新时间规则更新；
- Composer text 和未提交附件保持 renderer cache 值；
- Pi 已经消费的 editor revision 必须按现有 editor sync contract 对齐；
- fresh bootstrap 不得创建第二个 assistant-ui runtime；
- repository converter 应通过结构共享减少未变化消息 DOM 替换。

普通 A -> B -> A 不触发 reattach，因为 A 在 hidden 期间持续更新。只有首次 cache、显式 retry、sequence gap、sidecar recovery、preload overflow 或 attachment failure 才请求 fresh bootstrap。

### 10.5 Push routing

每个 attachment listener 捕获 `{ attachmentId, recordGeneration, sessionKey }`。收到 push 时同时验证：

1. `attachmentId` 仍是 manager 为该 record 提交的 lease；
2. record 仍注册且 generation 未 tombstone；
3. payload projectId/threadId 与 record identity 一致；
4. sequence 满足该 record store contract。

Router 当前 location 不参与接收校验；inactive record 必须正常应用匹配 push。attachment/identity/generation 不匹配时丢弃并清理 stale lease；只有匹配 lease 的 sequence gap 才触发该 record 的 single-flight resync，不得写入其他 record或 resync 当前可见但无关的 session。

### 10.6 ACK 与背压

每个 attachment 独立维护 pending event/byte 计数、preload buffer 和 ACK。main 的待确认消费者键必须是 `(webContentsId, attachmentId)`，不能只使用 `webContentsId`，因为同一窗口可能同时订阅同一 worker/session 的多个独立 lease 生命周期。

同一个 sidecar event 可以 fan out 给多个窗口/attachments。只有所有实际接收该 event 的 attachment consumer 都 ACK、被 detach，或进入 recovery 并释放 credit 后，main 才向 worker 返回对应 credit。某个 attachment 超时或溢出时，只将该 lease 标记 recovering 并释放其 consumer credit，不得暂停、detach 或 resync 其他 leases。

### 10.7 Detach 与 retire ownership

cached `SessionProvider` 的 unmount、Activity hidden effect cleanup 和 terminal cleanup 均不得直接调用 `sessions.detach()`。

只有 `SessionTransportManager` 可以按 token detach。route switch 和进入 settings 不 detach；cache retire、replace/resync、materialize rollback 和窗口销毁才清理 lease。

archive/delete/Project remove 必须执行 transport-safe retire：先 tombstone record generation 并禁用命令，再 detach 对应 committed lease或失效 in-flight request，最后删除 record/stores/Activity。迟到 bootstrap 必须只 detach 自己返回的 token，不得复活已删除 record。main 的 session/Project 删除也必须清理所有窗口中 identity 匹配的 subscriptions。

### 10.8 Background running session

inactive cached session 继续由 main sidecar worker运行，并通过自己的 attachment 向 renderer 实时推送 timeline/control。Sidebar running、loading 和错误摘要直接来自对应 record summary，不依赖 catalog refresh 或重新进入 route。

未访问、未缓存的 catalog session 不自动 attach；其摘要仍可通过 catalog refresh 更新。若未来引入 LRU，淘汰 record 必须先完成 10.7 的 retire。

## 11. 导航与命令流程

### 11.1 打开 session

```text
Thread link activation
  -> optional draft/composer confirmation
  -> navigate({ projectId, threadId })
  -> route becomes navigation truth
  -> ensure cache record
  -> SessionTransportManager attaches the record (if first time)
  -> bootstrap commit
  -> session surface becomes ready
```

不再先调用 `openThread()` 完成 attach，再提交 active thread。由于 attach 不在 route loader/beforeLoad 中执行，TanStack Router navigation 在 URL commit 后已经完成；attach 过程必须由目标 record 的 `connectionState: "attaching" | "ready" | "error"` 表达，不能称为 route pending。

### 11.2 Attach failure

attach B 失败时：

- B route显示 session-scoped error surface；
- B record 可以保留错误和现有 Composer state；
- 不得把 A 重新标记为 active 而 URL 仍是 B；
- 用户可 retry B、Back 返回 A，或由明确操作 `replace` 到 fallback；
- 错误处理不得静默恢复到另一个 session；
- main/preload 若仍保留 A session 的 stale subscription，manager 在 attach B 后使用 compare-and-swap 从 main 替换，不会 detach 其他 cache records。

### 11.3 浏览器前进和后退

Back/Forward 与 Sidebar click 使用同一 activation 流程。不得为 history navigation 建立绕过 Router 的 controller path。

### 11.4 新建与 materialize

```text
navigate(/new?projectId=P)
  -> draft Activity visible
  -> user composes
  -> submitDraft()
  -> SessionTransportManager materialization intent
  -> cache.createRealRecord(S, with materialization lease)
  -> sessions.create + attach (via manager, with replaceAttachmentId=null)
  -> transfer/reseed Composer payload
  -> replace(/projects/P/session/S)
  -> materialization lease converts to ordinary cache lease
  -> draft record evicted
```

materialize 使用以下不可回滚边界：

| 结果 | 路由与缓存行为 |
| --- | --- |
| create 或 attach 失败 | 清理未提交真实 session，保留 draft record 和 Composer，停留 `/new` |
| attach 后 readiness 非 ready | 真实 session 已 committed；创建真实 record、reseed Composer，并 `replace` 到 session route |
| 首条命令 `preflightResult(false)`，Pi 未接受输入 | 清理未提交真实 session，保留 draft record 和 Composer，停留 `/new` |
| `preflightResult(true)`，包括 extension 已处理但未产生 user message | 真实 session 已 committed；`replace` 到 session route，不得回滚或重复提交 |
| Pi 接受输入后的 provider/tool/run 异步失败 | 保留真实 session、用户输入和错误 timeline，`replace`/停留真实 session route |

只有 Pi 明确未接受首条输入时才允许回到 draft。不能用 assistant-ui append Promise 的晚期 rejection 推断输入未被 Pi 接受。具体提交点继续遵守 Pi-native runtime 规范的 typed preflight 结果。

### 11.5 Branch

branch 成功返回新 thread ID 后：

1. refresh Project catalog；
2. ensure branch thread 出现在 catalog；
3. navigate 到新 session route；
4. manager 创建新 record 并 attach；
5. 源 session cache 与 attachment 保留。

### 11.6 Archive 与 unarchive

归档列表继续存在于 Sidebar catalog UI，但 archived session 不直接进入 session route。归档动作成功后：

- 从 regular catalog 移到 archived catalog；
- 归档当前 session 时选择下一 regular session route；
- 存在下一条时使用 `replace`，避免 Back 进入 archived route；
- 无下一条时 `replace` 到 `/new?projectId=...` 或 Project empty route；
- 归档 inactive session 不改变当前 route；
- 归档是显式 cache 生命周期操作，必须执行 10.7 的 retire 后清理对应 record；若 record 的 Composer 非空或有 pending attachment，归档确认必须明确提示会丢弃缓存输入；
- deep link 指向 archived session 时显示不可打开状态和 unarchive 操作，不 attach。

unarchive 成功后：

- 将条目恢复到 regular catalog；
- 不自动切换当前 route；
- 用户随后打开时创建 cache record，manager 建立新 attachment；
- unarchive 不复活归档前已经显式清理的 renderer-only Composer/DOM state。

### 11.7 删除当前 session

删除前必须先 tombstone record generation 并禁用命令（10.7），成功后再执行：

1. 从 catalog 删除；
2. manager 释放对应 lease（带 attachment token 检查）；
3. 从 cache registry 删除并卸载 Activity/runtime；
4. 清理对应 timeline/control/workbench summary；
5. 选择下一 regular session 或 draft/empty route；
6. 使用 `replace`，避免历史返回已删除 URL。

删除非当前 session 只清理其 catalog/cache/lease，不改变当前 route。main 的 session 删除 handler 也必须清理所有窗口中 identity 匹配的 subscriptions。

### 11.8 Project remove

Project remove 先 tombstone 该 Project 全部 record generations，清理全部 manager leases，再逐 record 执行 retire 流程（10.7）。若当前 route 属于该 Project，使用 `replace` 导航到其他可用 session、draft 或 root empty state。main 的 Project remove handler 也必须清理所有窗口中身份匹配的 subscriptions。

## 12. 状态模型迁移

### 12.1 DesktopState 保留项

保留窗口级：

- `projects`；
- `threadCatalogs`；
- `loading` 的 catalog/global 部分；
- `error`；
- 必要的最近访问摘要。

### 12.2 移出 DesktopState 的 active session 项

迁移到 per-session records：

- active-only `bootstrap`；
- `controls[sessionKey]`；
- `workbenches[sessionKey]`；
- active timeline store；
- active runtime refs。

`controls` 和 `workbenches` 若迁移期继续存于 DesktopState，必须由 record identity读取且不能再决定 active route。最终所有权以避免重复缓存为准。

### 12.3 删除或降级的导航状态

以下状态不再是导航权威：

- `activeThreadIds`；
- `pendingThreadLoad`；
- `selectNavigationProjectId()`；
- `selectNavigationThreadId()`；
- controller `navigationGeneration` 对 active selection 的提交。

Router location 取代它们。manager per-record generation 仍保留，但只隔离单个 identity 的 attachment 竞态，不维护第二套 selected thread。

### 12.4 Controller 拆分

现有 `useDesktopController()` 拆为：

```text
DesktopCatalogController
  -> projects/catalog/CRUD/draft config

SessionCacheController
  -> ensure/remove/touch/summary/retire

SessionTransportManager
  -> attach/flush/detach/resync per record lease

SessionCommandController
  -> prompt/edit/reload/cancel/compact/workbench
  -> connection guard: active route + ready generation + committed lease

SessionNavigation
  -> typed navigate/replace
```

不得在一个 hook 内同时维护 Router location、manager lease registry、cache registry 和 assistant-ui runtime refs。

## 13. 错误与并发

### 13.1 快速切换

A -> B -> C（假设三个独立 session）：

- Router location C 是最终 active identity；
- A/B/C 各有独立 cache record 和 attachment lease，route 切换不启动新的 attach，因为 A 和 B 已在 cache 且持有 lease；
- 只有 C 首次进入 cache 才会引起一次 per-record serialized attach，不影响 A/B 的已有 lease；
- 若 B 尚在 attaching 期间便切换到 C，manager 将序列化：等待 B attach settle 后只清理 B 的 stale lease，再启动 C 的 attach；
- A/B cache state 均不因快速切换被删除；
- 只有 route identity、C cache record identity、C committed lease generation 和 C command coordinator identity 一致时，C surface 才可发送命令。

### 13.2 Route 与 runtime 一致性

任意可发送状态必须满足：

```text
route identity
  === cache record identity
  === committed lease identity
  === command coordinator target identity
cache record connection state === "ready"
route visible Activity refers to the same key
```

不一致期间 Composer 显示 loading/disabled，不能把 prompt 发送到 identity 或 generation 不匹配的 lease。

### 13.3 Cache schema failure

某 record 的 snapshot/schema 不兼容时：

- 只隔离该 record；
- active 时显示可诊断错误并允许 fresh reload；
- 不得清空其他 cached sessions；
- fresh bootstrap 仍失败时才允许用户显式清理 record。

### 13.4 Memory pressure

首期不自动淘汰，但必须避免无界复制消息正文：

- record timeline 是唯一 renderer message source；
- assistant-ui repository 只做引用复用投影；
- DesktopState 不再复制 session message arrays；
- hidden activity 的 `SessionProvider` 不注册任何 transport listener。所有 attachment listener 集中在 `SessionTransportManager` 窗口级 registry。
- 开发诊断暴露 cache entry 数、timeline node 数和可见/隐藏状态。

## 14. 目录与模块建议

```text
app/
  desktop-shell.tsx
  session-cache-host.tsx
  routes/
    index.tsx
    new.tsx
    projects.$projectId.session.$threadId.tsx

runtime/
  session-transport-manager.ts
  pi-session-store.ts
  use-pi-session-runtime.ts
  use-draft-runtime.ts

state/
  session-cache-context.tsx
  session-cache-store.ts
  session-cache-selectors.ts
  session-navigation.ts
  desktop-catalog-controller.ts

components/layout/
  desktop-thread-list.tsx
  desktop-thread-list-item.tsx
```

最终文件名可按实现收敛，但依赖方向必须保持：

```text
Router/navigation -> cache activation
transport -> per-session stores
per-session runtime -> per-session stores
Sidebar -> Router + catalog/cache summaries
Session UI -> active SessionProvider
```

禁止 `runtime -> app/routes`。runtime 接收结构化 identity/active 参数，不直接调用 route hooks。

## 15. 分阶段实施

### Phase 0：Characterization

- 补充当前 attach、draft、branch、archive/delete 和 settings 生命周期测试；
- 验证 React 19.2 Activity 在当前 assistant-ui 版本下保持 Composer、message DOM 和 runtime state；
- 记录 A -> B -> A 当前 DOM/runtime identity；
- 确认 hidden effect cleanup 不调用全局 detach。

若 Activity 无法稳定保持 assistant-ui runtime，停止后续迁移并更新规范选择自建 keep-alive host，不得退回 Router match cache 假设。

### Phase 1：Router identity

- 增加 typed session route 和 draft route；
- 让 Sidebar active 样式从 route params 派生；
- 普通 thread click 改为 typed navigation；
- 保留旧 runtime/controller 作为临时 attach 实现；
- 覆盖 deep link、Back/Forward 和 invalid params。

### Phase 2：Session cache records

- 增加 `SessionCacheProvider`、record external stores 和 summaries；
- 将 `PiThreadStore` 从模块级单例改为 per-record；
- 增加 `SessionCacheHost` 与 Activity；
- 确保 route switch 不删除 record。

### Phase 3：Per-session assistant-ui runtime

- 将 `usePiRuntime()` 拆为 `usePiSessionRuntime()` 与 draft runtime；
- 每个 Activity 创建独立 `AssistantRuntimeProvider`；
- 移除 assistant-ui thread-list adapter 的导航职责；
- 将 Sidebar 从 active assistant-ui context 解耦；
- 迁移 Composer dirty/running 摘要。

### Phase 4：Multi-attachment transport

- 增加 `SessionTransportManager` 窗口级 lease registry；
- 将 attach/flush/detach/resync 从模块级 `piSessionBus` 移出，改为 per-record lifecycle 驱动；
- 实现 per-namespace serialized attach、lease token compare-and-swap 和 main subscription map；
- 修改 preload 从单 attachment buffer 改为 `Map<attachmentId, buffer>`；
- 修改 preload API 以支持 `flush(attachmentId)` / `detach(attachmentId)`；
- 修改 main `SessionSupervisor` subscription 从 `Map<webContentsId, RendererSubscription>` 改为 `Map<webContentsId, Map<attachmentId, RendererSubscription>>`；
- ACK consumer key 改为 `(webContentsId, attachmentId)`；
- 删除全局 `piSessionBus` 单例。

### Phase 5：Transport-aware CRUD 与 draft

- materialize 使用 manager materialization lease，满足 ttl lifetime 校验；
- branch 后 navigate 新 route，manager 为新 record 建立 attachment；
- archive/unarchive/delete/remove Project 执行 10.7 retire 流程；
- 删除 `activeThreadIds/pendingThreadLoad` 的导航职责；
- 更新冲突的旧规范状态或 supersession 说明。

### Phase 6：验证与性能

- 执行 focused tests、root check 和 Electron CDP 验收；
- 验证 hidden DOM、Activity state、terminal/panel 和流式消息；
- 记录多缓存 session 的内存指标；
- 根据测量结果另行决定 LRU，不在本阶段静默加入淘汰。

## 16. 测试计划

### 16.1 Router

至少覆盖：

- session URL包含 projectId/threadId并正确编码特殊字符；
- Sidebar click只触发一次 navigate，不直接 attach；
- deep link cold start打开指定 session；
- Back/Forward恢复对应 cached activity；
- route preload 只 prewarm，不 attach/open Project；
- invalid Project/thread显示明确错误；
- settings与session route切换不销毁 cache record；
- 删除/归档 active session 使用 replace。

### 16.2 Cache 与 React

至少覆盖：

- A -> B 后 A Activity hidden但 record/runtime未卸载；
- A -> B -> A 保留 A Composer text和attachments；
- A message DOM identity在切回后保持，fresh bootstrap只更新变化节点；
- Panel、Terminal容器、scroll和折叠状态保持；
- 同一 session key 只有一个 provider/runtime；
- 删除 session 才卸载对应 activity；
- Project remove只清理匹配 records；
- settings cold start不创建 session runtime。

### 16.3 Runtime 隔离

至少覆盖：

- A/B拥有不同 `PiThreadStore`、repository和command coordinator；
- A push不能写入 B record；
- hidden runtime不能发送命令；
- reattach A不创建第二个 runtime；
- bootstrap replace不清空 A Composer；
- summary不复制 Composer正文或message arrays。

### 16.4 Transport（多 attachment）

至少覆盖：

- 同一窗口同时为多个缓存 session 维护独立 committed lease 并分别接收 push；
- 同一 session key 最多一个 committed lease；
- A 的 sequence gap 触发 A 的 single-flight resync，不干扰 B 的已有 lease 或 push 流；
- attach 携带 `replaceAttachmentId` 时，main 只替换对应 lease；stale replace token 不覆盖较新 lease；
- `sessions.flush(attachmentId)` 只释放目标 buffer；`sessions.detach(attachmentId)` 只释放对应 lease；
- preload buffer overflow 返回 typed recovery result，manager 标记该 record recovering 并执行 replace/resync；
- main `(webContentsId, attachmentId)` ACK 键隔离同窗口不同 session；
- 进入 settings 不 detach 已缓存 record，离开后不重复 attach；
- archive/delete 当前 session：先 tombstone generation，再 detach lease，最后 replace route；迟到 bootstrap 只 detach 自己 token；
- 窗口销毁清理全部 leases。

### 16.5 Draft 与 CRUD

至少覆盖：

- `/new` 不创建 Pi session；
- 首次有效 submit 只 create 一次并 replace 真实 route；
- create/attach/preflight false 保留 draft runtime 和 Composer；
- readiness 非 ready 与 preflight true 均提交真实 route；
- Pi 接受首条输入后的异步失败不回滚 draft；
- branch保留源cache并打开新record；
- archive/delete 当前 session 选择正确 fallback route；
- archived deep link 不 attach，unarchive 后可由普通 route 首次打开；
- 删除 inactive session 清理对应 record 和 lease，不影响其他 cache records；
- Project remove 清理全部匹配 cache。

### 16.6 Electron/CDP

至少验证：

1. 打开 A，输入未发送内容并调整 Panel/Terminal；
2. 切到 B，A DOM 处于 hidden 且没有交互，A 的 push 仍正常写入 Sidebar 摘要和 record store；
3. B 正常发送和流式输出；
4. Back 回 A，Composer、附件、scroll 和 Panel/Terminal 状态保留；
5. A 历史因持续接收 push 已与 Pi 权威一致，不需要 fresh bootstrap；
6. 多次 A/B 快速切换没有消息串线或错误 detach；
7. 进入 settings 再返回，session cache 保留；
8. 删除当前 session 后 Back 不会进入已删除地址。

## 17. 验证命令

route源文件变更后：

```sh
npm --prefix packages/desktop run generate-routes
```

修改或新增测试后，从 package目录逐个运行：

```sh
cd packages/desktop
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

代码实现最终运行：

```sh
npm --prefix packages/desktop run typecheck
npm run check
```

文档变更至少运行：

```sh
git diff --check
```

不运行完整 `npm test` 或 `npm run build`，除非用户明确要求。

## 18. 验收标准

1. 每个真实 session 拥有 `/projects/$projectId/session/$threadId` URL。
2. Router location 是 active session 唯一导航真相。
3. 每个 cached session 有独立 assistant-ui runtime 和 per-session external stores。
4. A -> B -> A 不卸载 A runtime，不丢失 Composer、attachments、scroll 和 session UI state。
5. session route 切换本身不删除 cache record 或 detach 已有 attachment；首期没有自动 LRU。
6. Sidebar 不依赖一个窗口级 multi-thread assistant-ui runtime 完成导航。
7. 普通 session 切换不调用 `runtime.threads.switchToThread()`。
8. 同一窗口可以为多个 cached sessions 持有独立 attachment lease。
9. 只有 `SessionTransportManager` 可以 attach/flush/detach/resync；同一 session key 的 attach/replace 严格串行，不同 key 不共享串行队列。
10. hidden SessionProvider cleanup 不能间接调用 `sessions.detach()`；stale attachment token 只清理自己。
11. fresh bootstrap 只更新目标 record，并保持 renderer-only Composer state。
12. deep link、Back/Forward、settings 和 draft 都遵守同一 route/cache 语义。
13. archive/unarchive/delete/Project remove 正确维护路由、catalog 和 cache；archived deep link 不 attach。
14. route preload 没有 active Project/session 副作用。
15. Pi-native timeline、sidecar worker、JSONL 和 command 语义不改变。
16. focused tests、desktop typecheck、root `npm run check` 和 Electron CDP 验收全部通过。

## 19. 风险与待验证项

### 19.1 React Activity 与第三方 runtime

虽然 React 19.2 Activity 设计用于保留 state 并隐藏 subtree，但 assistant-ui runtime、Radix portal、xterm 和文件面板必须通过 characterization 验证。尤其需要确认：

- hidden/visible 不会重复注册全局 listener；
- portal 内容随 activity 正确隐藏；
- xterm resize/fit 在重新 visible 后恢复；
- assistant-ui Composer 和 message parts 保持 identity；
- hidden effect cleanup 不触发业务级 detach。

### 19.2 内存增长

不自动淘汰最符合“切换不卸载”的产品要求，但长时间访问大量大 session 会增加 DOM 和 repository 内存。实现必须先测量，再提出独立 cache 容量规范；不得未经产品决策加入静默淘汰。

### 19.3 Inactive running 摘要

多 attachment 架构下，inactive cached session 实时接收 timeline/control push，Sidebar 摘要可直接来自 record summary，不滞后。未缓存的 catalog session 的摘要仍通过 catalog refresh 更新。

### 19.4 Draft 到真实 runtime迁移

assistant-ui Composer 包含附件和内部状态，不能假设修改 record key 即可无损迁移。Phase 0 必须 characterize 并决定使用现有 capture/reseed 流程或明确的 runtime handoff，失败时优先保证用户输入不丢失。

## 20. 参考

- [Desktop Renderer 架构规范](./renderer-architecture.md)
- [Desktop Pi-native assistant-ui External Store Runtime 规范](./pi-native-assistant-ui-runtime-spec.md)
- [Desktop 新会话草稿规范](./new-session-draft-spec.md)
- [Desktop assistant-ui ThreadList Primitives 集成规范](./assistant-ui-thread-list-primitives-spec.md)
- [Desktop Node Sidecar 规范](./node-sidecar-per-thread-spec.md)
- [TanStack Router 路由配置](../src/renderer/src/app/app-router.tsx)
- [React Activity API](https://react.dev/reference/react/Activity)
- [TanStack Router Route Matching](https://tanstack.com/router/latest/docs/framework/react/guide/route-matching)
