# Desktop assistant-ui Thread Adapter 与原子 Attach 规范

状态：Superseded
最后更新：2026-07-17

> 本规范中的 `UseAgUiThreadListAdapter`、窗口级单 active attachment、AG-UI bootstrap、history import 和 active-run join 已由 [Desktop Session 路由与 Runtime 缓存规范](./session-route-cache-spec.md) 取代。本文仅保留历史决策背景，不再作为实现依据。

## 1. 背景

当前 Desktop 已使用 `@assistant-ui/react-ag-ui` 消费 Pi 转换出的 AG-UI 事件，但 session 恢复仍由 Desktop 自行编排：

```text
sessions.open()
  -> SessionEventBus.activate()
  -> React key 重建 runtime
  -> ThreadHistoryAdapter.load()
  -> 轮询 assistant-ui history head
  -> runtime.thread.startRun()
```

该链路存在两个结构性问题：

1. `open()` 返回 bootstrap 与 `subscribe()` 建立推送不是一个原子操作，中间产生的事件只能依赖 renderer 临时 buffer 补偿。
2. active run 续接依赖 assistant-ui runtime 内部的 history hydration 时序。切回正在运行的 session 时，live replay 可能先于历史 hydrate，造成只显示流式消息、settle 后历史才恢复。

本规范替代 `ag-ui-integration-spec.md` 中关于 thread 切换、bootstrap 订阅和 renderer active-run attach 的设计。Pi -> AG-UI 映射、Desktop 控制面、catalog 和 runtime single-flight 仍沿用原规范。

## 2. 决策

1. 使用 `@assistant-ui/react-ag-ui` 的 `UseAgUiThreadListAdapter` 作为跨 session 切换与消息 hydrate 的唯一入口。
2. 不再通过 React `key` 重建 assistant-ui runtime。
3. 不再使用自制 history-head hydration barrier。
4. main 提供单一原子 `attach` 操作，在同一主进程执行片段内生成 bootstrap cursor 并替换窗口订阅。
5. preload 只允许每个 renderer window 存在一个 active attachment，与 main 的 `webContents.id -> attachment` 模型保持一致。
6. AG-UI sequence 仍由 main 按 session 单调递增；bootstrap `cursor` 表示该基线已经覆盖的最大 sequence。
7. 跨 thread 恢复使用官方 thread adapter 返回消息；同 thread sequence 失步使用 assistant-ui 公共 `thread.import()` 原子替换消息。
8. active run 仍由 `ElectronPiAgent` 消费 AG-UI `BaseEvent`。不把事件二次转换为 `ChatModelRunResult`。

## 3. assistant-ui API 边界

当前依赖版本：

```json
{
  "@assistant-ui/react": "0.14.26",
  "@assistant-ui/react-ag-ui": "0.0.44"
}
```

`UseAgUiThreadListAdapter.onSwitchToThread()` 支持返回：

```ts
{
  messages: readonly ThreadMessage[];
  state?: ReadonlyJSONValue;
  unstable_resume?: boolean;
}
```

官方 runtime 保证 `onSwitchToThread()` resolve 后依次执行：

1. 清空旧 thread 消息；
2. 应用返回的 `messages`；
3. 应用返回的 `state`；
4. `unstable_resume` 为真时调用 `resumeInFlightRun()`。

当前版本的 `unstable_resume` 要求 `ThreadHistoryAdapter.resume()` 返回 `AsyncGenerator<ChatModelRunResult>`。它不能直接消费 AG-UI `BaseEvent`，也不会重新连接自定义 Electron `AbstractAgent` transport。

因此本实现：

- 使用 thread adapter 的官方消息 hydrate 和 thread lifecycle；
- 不设置 `unstable_resume`；
- 在 `runtime.threads.switchToThread()` 完成后，以 hydrate 后的 history head 调用一次 `runtime.thread.startRun()`；
- `ElectronPiAgent` 识别 attach 中的 active run，只 replay/join 已有 run，不向 main 重复发送 `sessions.run()`。

这层 active-run join 是当前 assistant-ui 版本的 transport 补充，不实现第二套消息聚合器。未来官方 runtime 支持直接恢复 `AbstractAgent` event stream 后，应删除该补充入口。

## 4. 目标架构

```text
Sidebar / startup
  -> AssistantRuntime.threads.switchToThread(threadId)
  -> UseAgUiThreadListAdapter.onSwitchToThread(threadId)
  -> SessionEventBus.attach(projectId, threadId)
  -> preload sessions.attach()
  -> IPC sessions:attach
  -> SessionSupervisor.attach(webContentsId, session)
       1. require SessionRuntime
       2. runtime.bootstrap() 得到 cursor
       3. 同步替换该窗口 attachment
       4. 返回 attachmentId + bootstrap
  -> assistant-ui applyExternalMessages()
  -> ElectronPiAgent join active run（如有）
```

## 5. IPC 合约

### 5.1 Bootstrap cursor

`SessionBootstrap.sequence` 重命名为 `cursor`：

```ts
interface SessionBootstrap {
  protocolVersion: 3;
  projectId: string;
  threadId: string;
  cursor: number;
  control: SessionControlState;
  messages: Message[];
  state: State;
  activeRun?: {
    runId: string;
    events: BaseEvent[];
  };
}
```

`cursor` 的语义是：bootstrap messages 与 active-run replay 已覆盖所有 `sequence <= cursor` 的事件。renderer 只能继续应用 `sequence > cursor` 的 push。

### 5.2 Attachment

main 与 preload 之间使用：

```ts
interface SessionAttachment {
  protocolVersion: number;
  attachmentId: string;
  bootstrap: SessionBootstrap;
}
```

所有 session push 必须携带 `attachmentId`：

```ts
type SessionPush =
  | { attachmentId: string; type: "control"; /* ... */ }
  | { attachmentId: string; type: "tool"; /* ... */ }
  | { attachmentId: string; type: "events"; /* ... */ };
```

`attachmentId` 只标识一次窗口 attach 生命周期，不替代 `runId` 或 sequence。

### 5.3 原子性

`SessionSupervisor.attach()` 必须按以下顺序执行：

1. `await requireRuntime(projectId, threadId)`；
2. 同步调用 `runtime.bootstrap()`；
3. 不经过新的 `await`，同步替换 `subscriptions[webContentsId]`；
4. 返回 `SessionAttachment`。

Node 主进程在步骤 2 与步骤 3 之间不会执行其他事件回调，因此不存在 bootstrap cursor 与订阅建立之间的事件缺口。`requireRuntime()` 期间产生的活动事件已经包含在随后生成的 bootstrap 中。

### 5.4 Preload API

renderer 只看到一个高层 API：

```ts
attach(
  projectId: string,
  threadId: string,
  listener: (push: SessionPushPayload) => void,
): Promise<SessionBootstrap>;

flush(): void;
detach(): void;
```

preload 内部负责：

- 在发起 invoke 前安装 pending listener；
- 缓存在 invoke resolve 前以及 assistant-ui hydrate 完成前收到的 push；
- 只转发与返回 `attachmentId` 相同的 push；
- 新 attach 使旧 attach generation 失效；
- stale attach resolve 后只尝试 detach 自己的 `attachmentId`，不得清理更新的 attachment；
- renderer 在 history hydrate 和 active-run listener 建立后调用 preload 本地 `flush()`，再按序释放当前 attachment 的缓存；
- renderer unload 时 detach 当前 attachment。

main 每个 `webContents.id` 只保存一个 attachment。删除 preload 的多 session listener map。

## 6. Renderer 所有权

### 6.1 Runtime 生命周期

每个 renderer window 只创建一个长期存在的 `useAgUiRuntime()`：

```tsx
const runtime = useAgUiRuntime({
  agent,
  adapters: {
    attachments: imageAttachmentAdapter,
    threadList,
  },
});
```

要求：

- `AssistantRuntimeProvider` 位于 Desktop 工作台公共组件之上；
- thread 切换不得给 provider、chat thread 或 runtime 设置 session 相关 `key`；
- `ElectronPiAgent` 实例跨 thread 保持稳定，通过显式 `attach(bootstrap)` 替换 transport 上下文；
- 不再为每个 bootstrap 创建 `ThreadHistoryAdapter`。

### 6.2 Thread adapter

adapter 必须提供：

- `threadId`：Desktop 当前 active thread；
- `threads` / `archivedThreads`：来自 Desktop session catalog；
- `onSwitchToThread`：执行原子 attach，并返回转换后的 bootstrap messages/state；
- `onSwitchToNewThread`：只在 renderer 新会话草稿首次提交时创建并 attach Pi session；Sidebar New 本身不得调用；
- `onRename`、`onArchive`、`onUnarchive`、`onDelete`：委托现有 Desktop 控制面。

Sidebar 可以继续使用现有布局，但 open/create/rename/archive/delete 命令必须调用 `AssistantRuntime.threads`，不得绕过 thread adapter 维护另一套切换生命周期。

### 6.3 Active run join

跨 thread 切换的顺序必须固定：

1. `ElectronPiAgent.attach(bootstrap)` 设置 project、thread、cursor 和 active replay；
2. `onSwitchToThread()` 返回转换后的历史；
3. assistant-ui thread adapter 应用历史；
4. `switchToThread()` resolve；
5. 若存在 `activeRun`，调用 `runtime.thread.startRun({ parentId: historyHead })`；
6. `ElectronPiAgent.run()` 先 replay bootstrap active events，再消费 `sequence > cursor` 的 push；
7. join 模式不得调用 main 的 `sessions.run()`。

该顺序不读取 assistant-ui 的 `isLoading` 或轮询 runtime message head。history head 直接取自已经交给 thread adapter 的最后一条消息。

### 6.4 同 thread resync

sequence 缺口或 schema 校验失败时：

1. 停止当前 AG-UI Observable；
2. single-flight 调用 `SessionEventBus.attach()`，原子替换同一窗口 attachment；
3. `ElectronPiAgent.attach(newBootstrap)`；
4. 调用 assistant-ui 公共 `runtime.thread.import(convertedMessages)`；
5. 若新 bootstrap 仍有 active run，按新 cursor 重新 join；
6. 丢弃旧 attachment 的所有迟到 push。

不得通过 React key 重建 runtime，也不得把 bootstrap 写入 Desktop reducer后等待组件卸载/重建。

## 7. SessionEventBus

`SessionEventBus` 只负责 renderer 进程内的 transport 分发：

- `attach()` / `detach()`；
- 当前 attachment 的 AG-UI batch 分发；
- control 分发到 Desktop reducer；
- tool update 分发到 tool external store；
- 同 thread resync single-flight。

删除：

- 多 session `eventListeners` map；
- 多 session `eventBuffers` map；
- `activate()` 与独立 `sessions.open()` 的组合；
- bootstrap listener 触发 React key 重建；
- renderer 自行维护的 256 batch 补偿 buffer。

hydrate 完成前的唯一必要 buffer 位于 preload，并按当前 `attachmentId` 隔离。

## 8. 并发与错误语义

### 8.1 快速切换

renderer 为每次用户切换分配本地 generation。旧 generation 后返回时：

- 不提交 Desktop active thread；
- 不 hydrate assistant-ui；
- 不 join active run；
- preload/main 的 attachment token 保证它不能 detach 新 attachment。

### 8.2 Sequence

- `batch.toSequence <= cursor`：整批丢弃；
- envelope `sequence <= cursor`：重复事件丢弃；
- 第一个未处理 envelope 必须等于 `cursor + 1`；
- 缺口进入 single-flight resync；
- resync 完成后 cursor 以新 bootstrap 为准。

### 8.3 Cancel 与 detach

- assistant-ui cancel：结束本地 Observable、调用 Pi `abort()`，完成后同 thread 原子 resync；
- thread switch/detach：只释放 renderer attachment，不 abort Pi；
- window destroyed：main 自动删除 attachment；
- session removed/project removed：main 删除对应 attachment，迟到 push 由 token 过滤。

## 9. 删除项

实现完成后必须删除：

- `createAgUiHistoryAdapter()`；
- `hydratedHistoryHead()`；
- `usePiRuntime()` 中 active-run hydration effect；
- `ActiveSession` 的 `${projectId}:${threadId}:${sequence}` key；
- `sessions.open()` + `sessions.subscribe()` 的非原子组合；
- `sessions.resync()` 的独立非订阅恢复入口；
- preload `Map<sessionKey, Set<listener>>`；
- `SessionEventBus` 的跨 session batch buffer。

AG-UI `Message -> ThreadMessage` 转换仍需保留，但应作为 thread adapter 的纯边界函数，不再伪装成 history persistence adapter。

## 10. 测试要求

### 10.1 Main / preload

- bootstrap cursor 与 attachment 注册之间无事件缺口；
- 同一窗口新 attach 原子替换旧 attach；
- push 只发送给匹配 attachment；
- stale detach 不会清理新 attachment；
- window destroyed、session remove、project remove 清理 attachment；
- invoke resolve 前 push 由 preload buffer，resolve 后按顺序交付。

### 10.2 Renderer

- official thread adapter 在历史 hydrate 后 join active run；
- 切回 live session 时历史和正在流式输出的消息同时存在；
- thread 切换不重建 assistant-ui runtime；
- idle session 切换不启动 run；
- join active run 不重复调用 `sessions.run()`；
- 重复 sequence 丢弃；
- sequence gap 通过 `thread.import()` 恢复，不依赖 React key；
- 快速 A -> B -> A 只提交最后一次切换；
- detach 不 abort Pi，cancel 会 abort 并恢复权威历史。

### 10.3 验收命令

修改或新增的 Vitest 文件必须逐个运行；最后在仓库根运行：

```sh
npm run check
```

不运行 `npm test` 或 build。

## 11. 验收标准

1. 所有 session 切换通过 `UseAgUiThreadListAdapter`。
2. main/preload/renderer 对窗口 attachment 的基数均为一。
3. bootstrap 和实时 push 之间不存在不可恢复的订阅缺口。
4. live session 切回后，历史消息在第一帧 hydrate 时即存在，live replay 只追加或更新 active assistant message。
5. sequence gap 使用同一 runtime 的 `thread.import()` 恢复。
6. renderer 不再存在 history hydration barrier、session-key runtime remount 或跨 session event buffer。
7. Pi queue、compaction、HostUi、extension UI、model/thinking 仍由现有控制面权威承载。
8. 定点测试与根级 `npm run check` 全部通过。

## 12. 实现状态

- `SessionSupervisor.attach()` 在同步 bootstrap/subscribe 边界生成 attachment token；
- preload 使用单 active attachment，并在 assistant-ui hydrate 完成前缓存 push；
- `DesktopProvider` 持有窗口级 `useAgUiRuntime()` 与 `AssistantRuntimeProvider`；
- Sidebar 的 thread 操作通过 `AssistantRuntime.threads` 进入 `UseAgUiThreadListAdapter`；
- bootstrap 使用官方 `fromAgUiMessages()` 转换；
- active run 由稳定 `ElectronPiAgent` replay/join，sequence gap 通过 `thread.import()` 恢复；
- 已删除 history adapter、hydration barrier、session-key runtime remount 和 renderer 跨 session event buffer；
- Desktop 12 个定点测试文件共 28 个测试通过；根级 `npm run check` 通过。
- 新会话 draft 按 [Desktop 新会话草稿规范](./new-session-draft-spec.md) 延迟到首次有效 submit 才进入 `onSwitchToNewThread()`。

## 13. 参考

- [`UseAgUiThreadListAdapter`](../../../node_modules/@assistant-ui/react-ag-ui/src/runtime/types.ts)
- [`useAgUiRuntime`](../../../node_modules/@assistant-ui/react-ag-ui/src/useAgUiRuntime.ts)
- [`AgUiThreadRuntimeCore.resumeInFlightRun`](../../../node_modules/@assistant-ui/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts)
- [`ExternalStoreThreadListAdapter`](../../../node_modules/@assistant-ui/core/src/runtimes/external-store/external-store-adapter.ts)
- [assistant-ui AG-UI Runtime](https://www.assistant-ui.com/docs/runtimes/ag-ui)
