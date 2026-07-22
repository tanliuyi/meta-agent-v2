# Desktop assistant-ui ThreadList Primitives 集成规范

状态：Superseded
最后更新：2026-07-16

> 本规范的 Project 分组和 thread CRUD 产品语义继续有效。其 `@assistant-ui/react-ag-ui`、`UseAgUiThreadListAdapter`、窗口级 thread navigation、`ElectronPiAgent`、history hydrate 和 active-run attach 实施细节已由 [Desktop Session 路由与 Runtime 缓存规范](./session-route-cache-spec.md) 取代，不再作为实现依据。

## 1. 背景

Desktop 已使用 `@assistant-ui/react-ag-ui` 和 `UseAgUiThreadListAdapter` 管理 Pi session 的切换、消息 hydrate 与 active run attach，但 Sidebar 仍用自制 React 列表渲染 session：

```text
Sidebar
  -> ProjectList / ThreadRows
  -> DesktopContext commands
  -> DesktopThreadActions
  -> AssistantRuntime.threads
  -> UseAgUiThreadListAdapter
  -> Electron IPC / Pi session
```

当前结构在行为上已经通过 assistant-ui thread runtime，但没有使用官方 `ThreadListPrimitive`、`ThreadListItemPrimitive` 和 `ThreadListItemMorePrimitive`。因此 active 状态、标题、归档列表、键盘导航和 action capability 仍由 Sidebar 自行拼装。

本规范定义如何在不破坏 Desktop 原子 attach、快速切换回滚、Workbench hydrate 和 Project 分组的前提下，引入 assistant-ui ThreadList primitives。

本规范只扩展 Sidebar 的 thread-list UI。以下既有规范继续有效：

- [Desktop AG-UI 集成规范](./ag-ui-integration-spec.md)负责 Pi -> AG-UI 映射、控制面和 session catalog；
- [Desktop assistant-ui Thread Adapter 与原子 Attach 规范](./assistant-ui-thread-attach-spec.md)负责 thread 切换、消息 hydrate、active run join 和 attachment 原子性；
- 单个会话的消息时间线由 assistant-ui `ThreadPrimitive.Viewport` 原生滚动负责，与 session 列表无关。
- [Desktop 新会话草稿规范](./new-session-draft-spec.md)替代本规范中“点击 New 立即创建 session”的流程。

## 2. 调研结论

Desktop 可以使用 ThreadList primitives，且不需要 Assistant Cloud、HTTP 服务或新的持久化层。

当前仓库已经满足运行条件：

1. `@assistant-ui/react` 固定为 `0.14.26`；
2. `@assistant-ui/react-ag-ui` 固定为 `0.0.44`；
3. `AssistantRuntimeProvider` 已覆盖整个 Desktop 工作台；
4. `usePiRuntime()` 已向 `useAgUiRuntime()` 注册 `UseAgUiThreadListAdapter`；
5. adapter 已提供 active、regular、archived、switch、create、rename、archive、unarchive 和 delete；
6. session metadata 与消息历史继续由 Electron main、`SessionSupervisor` 和 Pi `SessionManager` 持久化。

不能直接把现有 `ThreadRows` 替换为 primitives 的默认动作。官方 `New`、`Trigger`、`Archive`、`Unarchive` 和 `Delete` 会直接调用 thread runtime，而当前 Desktop 还必须在 runtime 操作外完成以下协调：

- 快速切换 generation 与 stale result 丢弃；
- attach 失败后的 committed thread 恢复；
- `SessionBootstrap`、`SessionControlState` 和 `WorkbenchState` 提交；
- `DesktopState.threadId` 与 adapter `threadId` 同步；
- 归档或删除当前 session 后选择下一 session，或清空工作台；
- 删除前确认和统一错误上报。

因此本规范选择“受控 primitive 集成”：primitive 提供 UI 语义和上下文，Desktop controller 保留命令编排。

## 3. 官方 API 边界

### 3.1 Primitive 能力

当前官方 API 提供：

```text
ThreadListPrimitive
  Root
  New
  Items
  ItemByIndex
  LoadMore

ThreadListItemPrimitive
  Root
  Trigger
  Title
  Archive
  Unarchive
  Delete

ThreadListItemMorePrimitive
  Root
  Trigger
  Content
  Item
  Separator
```

与 Desktop 直接相关的行为：

- `Items` 使用 children render function，`components` 已废弃；
- `Items archived` 渲染归档项；
- `Root` 根据 `mainThreadId` 设置 `data-active` 和 `aria-current`；
- `Trigger` 是原生 button，并调用当前 item 的 `switchTo()`；
- `New` 调用 `switchToNewThread()`；
- action primitives 根据 runtime capability 自动禁用；
- item 支持 Tab、上下方向键和 More 菜单焦点导航；
- `ThreadListItemMorePrimitive.Root sharedFocusGroup` 将 More 菜单纳入同一键盘焦点组。

### 3.2 External store 约束

AG-UI runtime 的 thread-list adapter 建立在 `ExternalStoreThreadListAdapter` 上。官方文档明确要求 runtime current thread 与外部 store selected thread 保持同步，否则消息可能进入错误的 thread 或消失。

当前安装版本的 external store runtime 不会在 callback 成功后自行修改外部列表。`switchToThread()`、`rename()`、`archive()` 和 `delete()` 只 await adapter callback，随后等待 React props 把新的 `threadId`、`threads` 和 `archivedThreads` 重新传入。

Desktop 的外部 store 是 `DesktopState`，所以所有成功操作仍必须提交 reducer；不能只依赖 primitive 内部状态。

### 3.3 稳定性

官方将 AG-UI multi-thread 标记为 experimental。当前安装版本还在 `ExternalStoreThreadListAdapter` 中把 `threadId`、`onSwitchToThread` 和 `onSwitchToNewThread` 标为 deprecated/active development。

要求：

- 继续精确锁定 assistant-ui 版本；
- primitive 集中在一个 Sidebar 边界组件内；
- adapter ID 映射集中在 runtime adapter 内；
- 升级 assistant-ui 时必须重新检查 primitive action composition、thread-list adapter 类型和切换时序；
- 不让业务组件直接依赖 node_modules 私有实现。

## 4. 当前状态模型

### 4.1 权威来源

| 数据 | 权威来源 | renderer 投影 |
| --- | --- | --- |
| Project 列表与 active Project | `ProjectStore` | `DesktopState.projects/project` |
| Session catalog、标题、排序、归档 | `SessionSupervisor` / `SessionManager` | `DesktopState.threads` |
| Active Pi session | main attachment + `DesktopState.threadId` | thread adapter `threadId` |
| 消息与 run | Pi session / AG-UI stream | assistant-ui current thread |
| readiness、queue、model、running | `SessionControlState` | `DesktopState.controls` |
| Workbench layout | Project workbench store | `DesktopState.workbenches` |
| rename、删除确认、归档展开 | Sidebar UI | component-local state |

`assistant-ui` 是消息时间线和 thread interaction runtime，不替代 Project store、Pi session catalog 或 Workbench store。

### 4.2 Adapter ID

当前 adapter 使用：

```text
adapter id = `${projectId}:${threadId}`
remoteId   = Pi threadId
```

要求：

- primitive item 的 runtime identity 始终使用 composite adapter ID；
- Desktop IPC 和 controller 始终使用 `remoteId` 对应的原始 Pi thread ID；
- UI 不得通过字符串切片反解 composite ID；
- item 缺少 `remoteId` 时必须显式报错，不得把 adapter ID 当作 Pi thread ID 静默继续；
- adapter 可通过 `custom` 暴露 `running` 等只读列表展示信息，但不得复制 bootstrap、messages 或 WorkbenchState。

## 5. 设计决策

### 5.1 采用受控 primitives

Sidebar 使用 primitives 建立列表结构和 item 上下文，但所有会改变 Desktop 状态的默认 action 都必须路由到现有 controller。

事件规则：

```tsx
<ThreadListItemPrimitive.Trigger
  onClick={(event) => {
    event.preventDefault();
    void desktop.openThread(threadId);
  }}
>
  <ThreadListItemPrimitive.Title fallback="新会话" />
</ThreadListItemPrimitive.Trigger>
```

当前 `@assistant-ui/react` 使用 Radix `composeEventHandlers()` 组合调用方 handler 与 primitive 默认 action。调用方执行 `preventDefault()` 后，默认 action 不会再次执行。

所有受控 action 必须满足：

1. 同步调用 `event.preventDefault()`；
2. 只调用一个 Desktop controller command；
3. controller command 内部继续只调用一次 `AssistantRuntime.threads`；
4. 不直接调用 `window.desktop.sessions.*`；
5. 不在组件内乐观修改 thread list。

禁止同时调用 `desktop.openThread()` 和 primitive 默认 `switchTo()`。这会触发两次 attach，并破坏 generation 与 committed-thread 回滚语义。

### 5.2 保留 Desktop controller

本次不把 reducer 提交、Workbench hydrate 或 fallback selection 搬进 experimental adapter callback。

保留：

- `DesktopThreadActions.open/enterDraft/submitDraft/discardDraft/rename/archive/remove`；
- `useDesktopController()` 的 thread commands；
- `dispatchPrepared()`；
- archive/delete 当前 session 后的 next-thread 选择；
- controller 统一错误上报。

这使 primitives 成为 UI 适配层，不成为第二个业务 controller。

### 5.3 保留 Project 分组

assistant-ui thread runtime 当前只接收 active Project 的 session。Sidebar 继续以 Project 为一级导航：

```text
Projects
  Project A
  Project B (active)
    regular session items
    archived session items
  Project C
```

约束：

- inactive Project 不渲染 thread primitive items；
- 切换 Project 仍调用 `desktop.openProject()`；
- Project 菜单继续使用现有项目级组件，不放入 thread item context；
- active Project 的 session 顺序沿用 `SessionSupervisor.list()` 的 `updatedAt` 降序，不在 renderer 二次排序；
- 不为每个 Project 创建一个 assistant-ui runtime。

### 5.4 不引入 Cloud 或 RemoteThreadListRuntime

不使用：

- `AssistantCloud`；
- `useRemoteThreadListRuntime()`；
- `InMemoryThreadListAdapter`；
- 新的 HTTP、SSE 或数据库 API。

原因是 Desktop 已有外部 store、Electron IPC、Pi JSONL 持久化和 AG-UI external-store adapter。引入另一套 thread runtime 会形成第二个生命周期与持久化来源。

### 5.5 不扩展 ThreadList 产品能力

本次不实现：

- `ThreadListPrimitive.LoadMore`：`SessionSupervisor.list()` 已返回 active Project 的完整 catalog；
- session 搜索或筛选：现有搜索按钮尚无对应产品合约；
- 拖拽排序：session 顺序继续由 main 的 `updatedAt` 决定；
- `generateTitle()`：Pi session title 继续由现有 title/control 链路管理；
- 跨 Project 的统一 session 列表：runtime 仍只投影 active Project。

这些能力需要独立的数据合约和产品决策，不作为 primitive 接入的附带功能。

## 6. 目标组件结构

建议结构：

```text
Sidebar
  ThreadListPrimitive.Root
    sidebar brand
    ControlledNewThread
    project heading
    ProjectList
      ProjectItem
        project row
        ActiveProjectThreadList
          ThreadListPrimitive.Items
            DesktopThreadListItem
          archive toggle
          ThreadListPrimitive.Items archived
            DesktopArchivedThreadListItem
    footer
  ConfirmDialog
```

职责拆分：

- `Sidebar`：删除确认、全局 rename draft、Project 选择；
- `ProjectList`：Project 层级和 active Project 容器；
- `ActiveProjectThreadList`：regular/archived iterator；
- `DesktopThreadListItem`：item primitives、运行中标记、More 菜单和受控 command bridge；
- `usePiRuntime`：adapter ID、hydrate、active run join；
- `useDesktopController`：成功提交、错误处理和 fallback selection。

具体文件名可以在实现时按现有目录调整，但不得把 runtime switching 逻辑复制进视觉组件。

## 7. Item 渲染规范

### 7.1 Regular item

regular session 使用：

- `ThreadListItemPrimitive.Root`；
- `ThreadListItemPrimitive.Trigger`；
- `ThreadListItemPrimitive.Title`；
- `ThreadListItemMorePrimitive.Root sharedFocusGroup`；
- `ThreadListItemMorePrimitive.Trigger/Content/Item`；
- 归档 action、重命名 action、删除 action。

active 样式只读取 `data-active`，不得继续独立比较并维护另一套 active class。允许保留 class 名作为 CSS hook，但状态必须来自 primitive attribute。

运行中圆点读取 adapter `custom.running` 或当前 Desktop thread metadata。它只是状态展示，不参与 active 判定。

### 7.2 Archived item

archived session 由 `ThreadListPrimitive.Items archived` 渲染，并提供恢复、重命名和删除。

归档区展开状态保持 component-local；它不是 session catalog 数据，不进入 Desktop reducer 或持久化协议。

### 7.3 Rename

assistant-ui 当前没有 rename primitive。重命名继续使用受控 input：

1. More menu 选择“重命名”；
2. row 进入编辑态并预填当前 title；
3. Enter 或 blur 调用 `desktop.renameThread(remoteId, title)`；
4. 成功后 adapter 由更新后的 `DesktopState.threads` 重新提供 title；
5. Escape 取消编辑且不调用 runtime；
6. trim 后为空时不提交，并恢复原 title。

不得直接修改 primitive item state。

### 7.4 Delete confirmation

删除必须保留确认对话框：

1. Delete primitive/menu item 的第一次 action 执行 `preventDefault()`；
2. Sidebar 保存 `{ adapterId, remoteId, title }`；
3. 用户确认后调用 `desktop.removeThread(remoteId)`；
4. controller 通过 runtime item delete 进入 adapter；
5. main 删除 Pi session 文件；
6. reducer 移除条目；
7. 删除当前 session 时打开下一 regular session，没有可用项时清空 attachment 和工作台。

确认前不得触发 primitive 默认 delete。

## 8. 交互流程

### 8.1 新建 session

```text
ThreadListPrimitive.New click
  -> preventDefault
  -> desktop.beginDraft()
  -> renderer-only draft
  -> 用户首次提交有效 prompt
  -> desktop.submitDraft()
  -> DesktopThreadActions.submitDraft(project)
  -> runtime.threads.switchToNewThread()
  -> adapter.onSwitchToNewThread()
  -> main sessions.create + atomic attach
  -> assistant-ui append 首条 user message
  -> dispatch draft-committed
  -> DesktopState / adapter props 同步
```

没有可用 Project 时 New 必须 disabled。draft 不进入 adapter arrays，也不使用 assistant-ui-only 临时 thread ID。

### 8.2 切换 session

```text
ThreadListItemPrimitive.Trigger click/keyboard activation
  -> preventDefault
  -> desktop.openThread(remoteId)
  -> generation++
  -> runtime.threads.switchToThread(adapterId)
  -> atomic attach + history hydrate + active run join
  -> dispatch thread-loaded
  -> DesktopState.threadId 更新
  -> adapter threadId 更新
```

快速 A -> B -> A 必须只提交最后一次 generation。stale result 不得更新 active、Workbench 或 attachment。

### 8.3 归档与恢复

```text
Archive/Unarchive action
  -> preventDefault
  -> desktop.setThreadArchived(remoteId, value)
  -> runtime item archive/unarchive
  -> main persistence
  -> reducer thread-archived
```

归档当前 session 时沿用 controller 的 next-thread/clear 逻辑。primitive 不得自行选择 fallback。

### 8.4 Project 切换

Project row 不属于 thread primitive action：

```text
Project row click
  -> desktop.openProject(projectId)
  -> sessions.list(projectId, true)
  -> DesktopState project-loaded
  -> 打开第一个 regular session，或 detach
  -> thread adapter 收到新 Project 的列表和 composite IDs
```

Project 切换期间旧 Project item 不得继续触发 thread command。

## 9. Loading、并发与错误

### 9.1 Pending 状态

要求：

- switch/materialize 期间禁用重复的同类 action；
- rename/archive/delete 对同一 item single-flight；
- pending 只用于交互禁用，不乐观改变 active、title、status 或列表顺序；
- operation settle 后清除 pending；
- active run 不阻止切换 thread，但切换只 detach renderer，不 abort Pi。

### 9.2 错误

所有 command error 继续进入 Desktop error toast。

失败时：

- switch 失败恢复 committed thread；draft materialize 失败保持 detached draft 和 Composer 内容；
- rename 保留原 title；
- archive/unarchive 保留原 status；
- delete 保留 item 和当前 attachment；
- primitive 不保留伪 active 状态；
- 不静默吞掉缺失 `remoteId`、Project 不匹配或 unsupported adapter capability。

### 9.3 Capability

action primitive 的 disabled 状态可以作为第一层能力提示，但不能替代 Desktop 条件：

- New 还需要至少一个 available Project；
- thread action 还需要有效 `remoteId`；
- pending action 必须禁用；
- 删除确认打开时不得重复提交。

## 10. 不采用的方案

### 10.1 直接使用 primitive 默认 actions

不采用。它会绕过 `DesktopThreadActions`，导致 reducer、Workbench 和 fallback selection 不同步，并失去现有 generation/rollback 边界。

### 10.2 把 reducer 提交搬入 adapter callback

首期不采用。该方案需要重新定义消息 hydrate 前后、React external-store props 更新和 Desktop committed-thread 的原子边界，并把更多产品状态耦合到 experimental API。

### 10.3 继续完全自制列表

不采用。它无法获得官方 item context、active/ARIA 状态、action capability 和键盘焦点组，并继续重复 runtime 已有语义。

### 10.4 为每个 Project 创建 runtime

不采用。当前窗口只允许一个 active attachment 和一个长期存在的 assistant-ui runtime。多 runtime 会破坏原子 attach 规范并增加隐藏 session 状态。

## 11. 实施范围

预计涉及：

- `packages/desktop/src/renderer/src/components/layout/sidebar.tsx`；
- `packages/desktop/src/renderer/src/components/layout/project-list.tsx`；
- 新的 thread-list item/bridge 组件；
- `packages/desktop/src/renderer/src/runtime/use-pi-runtime.ts` 中 thread metadata `custom` 投影；
- Sidebar/thread-list CSS；
- focused renderer/controller tests。

默认不修改：

- main `SessionSupervisor`；
- preload 和 IPC contracts；
- `ElectronPiAgent`；
- Pi -> AG-UI mapping；
- message timeline virtualization；
- Project persistence 和 Pi JSONL 格式。

如果实现发现必须修改这些默认不变边界，应先更新本规范并解释原因，不得顺手扩展范围。

## 12. 分阶段实施

### 阶段一：UI adapter

- 增加 active Project 的 `ThreadListPrimitive.Items` 与 archived iterator；
- 增加 item root、trigger、title 和 More menu；
- 保留现有 CSS 密度、running dot 和 Project hierarchy；
- adapter `custom` 只补充列表展示所需 metadata。

### 阶段二：受控 commands

- New、switch、archive、unarchive、delete 全部接入 prevent-default bridge；
- rename 继续调用 controller；
- 保留删除确认；
- 增加 pending 和重复提交保护；
- 删除旧 `ThreadRows` 自制 active/action 逻辑。

### 阶段三：验证与清理

- 覆盖 CRUD、快速切换、失败回滚和 Project 切换；
- 验证键盘导航和 `aria-current`；
- 验证 active run 切换不 abort；
- 删除不再使用的 session 级 `radix-ui` DropdownMenu 代码；
- 保留 Project 菜单所需依赖和实现。

## 13. 测试要求

### 13.1 单元测试

至少覆盖：

- adapter regular/archived 顺序与 composite ID；
- primitive item 只使用 `remoteId` 调用 controller；
- 受控 handler 先 `preventDefault()`，每次操作只调用一次 controller；
- 缺失 `remoteId` 显式失败；
- rename 空标题不提交，Escape 取消；
- archive/unarchive 成功后列表分区更新；
- delete 确认前不调用 runtime；
- active delete/archive 后选择下一 regular session 或清空；
- command 失败不产生乐观状态。

### 13.2 集成测试

至少覆盖：

- New 不创建 Pi session，首次有效 submit 只创建一个 Pi session；
- Trigger 只执行一次 attach；
- 快速 A -> B -> A 只提交最后一次切换；
- 切回 running session 后历史与 live replay 同时存在；
- Project 切换后只显示新 active Project 的 session；
- archived iterator 只渲染 archived items；
- `data-active`、`aria-current`、Tab、上下方向键和 More menu 焦点有效；
- 删除确认取消不产生持久化变更。

### 13.3 验收命令

修改或新增的测试必须从对应 package 运行并迭代通过：

```sh
cd packages/desktop
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

最后从仓库根运行：

```sh
npm run check
```

不运行 `npm test` 或 build。

## 14. 验收标准

1. active Project 的 regular/archived session 由 ThreadList primitives 渲染。
2. Project hierarchy、session 排序、running 状态和删除确认保持现有产品语义。
3. 所有 thread command 仍只经过一次 `AssistantRuntime.threads`。
4. New 不 create，首次 submit 不出现双 attach、双 create、双 archive 或双 delete。
5. `DesktopState.threadId`、adapter `threadId` 和 assistant-ui `mainThreadId` 最终一致。
6. switch 失败恢复 committed thread；draft create/attach 失败保留草稿，Workbench 不进入错误 session。
7. primitive 提供的 active/ARIA 和键盘导航通过验证。
8. 不引入 Cloud、RemoteThreadListRuntime 或第二套持久化。
9. main/preload/AG-UI 协议不因本次 UI 集成发生变化。
10. focused tests 与根级 `npm run check` 全部通过。

## 15. 参考资料

- [assistant-ui ThreadList Primitive](https://www.assistant-ui.com/docs/primitives/thread-list)
- [assistant-ui Threads concepts](https://www.assistant-ui.com/docs/runtimes/concepts/threads)
- [assistant-ui AG-UI Runtime options](https://www.assistant-ui.com/docs/runtimes/ag-ui/runtime-options)
- [`UseAgUiThreadListAdapter`](../../../node_modules/@assistant-ui/react-ag-ui/src/runtime/types.ts)
- [`ExternalStoreThreadListAdapter`](../../../node_modules/@assistant-ui/core/src/runtimes/external-store/external-store-adapter.ts)
- [`ExternalStoreThreadListRuntimeCore`](../../../node_modules/@assistant-ui/core/src/runtimes/external-store/external-store-thread-list-runtime-core.ts)
- [`ThreadListPrimitive.New`](../../../node_modules/@assistant-ui/react/src/primitives/threadList/ThreadListNew.tsx)
- [`ThreadListItemPrimitive.Trigger`](../../../node_modules/@assistant-ui/react/src/primitives/threadListItem/ThreadListItemTrigger.tsx)
