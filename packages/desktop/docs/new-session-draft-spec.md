# Desktop 新会话草稿规范

状态：Implemented
最后更新：2026-07-16

> 本规范的 renderer-only draft、显式 Project/model/thinking 选择和“首次有效提交才创建 Pi session”产品语义继续有效。文中的 `ElectronPiAgent`、AG-UI run、attach/replay 和 transport 实施细节已由 [Desktop Pi-native assistant-ui External Store Runtime 规范](./pi-native-assistant-ui-runtime-spec.md) 取代，不再作为实现依据。

## 1. 背景

当前 Desktop 把“点击新建任务”和“创建 Pi session”视为同一个动作：

```text
ThreadListPrimitive.New
  -> desktop.createThread()
  -> DesktopThreadActions.create(project)
  -> runtime.threads.switchToNewThread()
  -> adapter.onSwitchToNewThread()
  -> window.desktop.sessions.create(projectId)
  -> SessionRuntime.create()
  -> attach + bootstrap
  -> reducer thread-created
```

这意味着用户只要点击“新建任务”，即使没有输入或发送 prompt，也会创建一个 main 进程 `SessionRuntime`，并把空 session 投影到 thread catalog。

产品需要引入独立的“新会话”概念。新会话是一个类似草稿的 renderer 状态：

- 用户可以输入 prompt、添加图片并选择目标 Project；
- 用户可以在创建 session 前选择模型和 thinking level；
- 草稿没有 Pi thread ID，不属于 session catalog；
- 草稿不会创建 `SessionRuntime`、JSONL session 或 WorkbenchState；
- 只有用户真实提交首个 prompt 时，才创建并 attach Pi session；
- 已有历史会话的 Composer 不显示 Project 选择器。

本规范定义该产品概念及其 renderer、assistant-ui runtime、Electron IPC 和错误边界。

## 2. 与现有规范的关系

本规范扩展并部分替代：

- [Desktop assistant-ui Thread Adapter 与原子 Attach 规范](./assistant-ui-thread-attach-spec.md)；
- [Desktop assistant-ui ThreadList Primitives 集成规范](./assistant-ui-thread-list-primitives-spec.md)。

替代范围仅限“新建 session”的触发时机：

1. `ThreadListPrimitive.New` 不再立即调用 `runtime.threads.switchToNewThread()`；
2. `onSwitchToNewThread()` 仍是 create + atomic attach 的唯一 runtime 入口，但只在草稿首次提交时调用；
3. 既有 thread attach、history hydrate、active-run join、rename、delete 和 generation 回滚语义继续有效；
4. 归档列表和归档交互不属于本规范。

## 3. 目标

1. 点击“新建任务”只进入 renderer 草稿态，不创建任何 Pi session。
2. Project 选择器只在草稿 Composer 中显示。
3. 草稿选择 Project 不打开 Sidebar Project row，不加载或切换该 Project 的历史 thread。
4. 草稿 Composer 提供模型和 thinking 选择，并把选择原子应用到首次创建的 session。
5. 首个 prompt 提交时只创建一个 Pi session，并把该 prompt 发送到同一 session。
6. create、attach 或附件预处理失败时保留草稿内容。
7. 重复点击发送不会创建多个 session。
8. 草稿不进入 assistant-ui `threads` / `archivedThreads`，也不使用伪 thread ID。
9. 已有会话切换、运行中恢复和 Workbench hydrate 不受影响。

## 4. 非目标

本次不实现：

- 草稿跨窗口或应用重启持久化；
- 多个并存的新会话草稿；
- 草稿出现在 Sidebar thread 列表；
- 草稿级 queue、HostUi 或 extension widgets；
- 草稿级 terminal、files panel 或 WorkbenchState；
- 归档 session 展示或恢复；
- Assistant Cloud、RemoteThreadListRuntime 或新的 HTTP API；
- 修改 Pi JSONL 格式。

## 5. 调研结论

### 5.1 当前 create 已经建立真实 runtime

`SessionSupervisor.create(projectId)` 会立即：

1. 调用 `SessionRuntime.create()`；
2. 创建 Pi `AgentSession`；
3. 加载模型、设置、资源和 extensions；
4. 把 runtime 放入 `SessionSupervisor.runtimes`；
5. 让 `sessions.list()` 立即返回该 session。

因此不能通过“创建后暂时不显示”实现产品草稿。草稿必须存在于 `sessions.create()` 之前。

### 5.2 SessionManager 的磁盘延迟不能替代产品草稿

Pi `SessionManager` 会延迟部分文件写入，但 `SessionRuntime`、session ID、模型状态和 catalog 投影已经存在于内存。产品语义要求用户发送首个 prompt 前不存在真实 session，所以不能把“尚未写 JSONL”视为草稿。

### 5.3 assistant-ui 没有适合 Desktop 的持久化草稿 item

当前 external-store thread runtime 的 new thread 语义最终仍会调用 `onSwitchToNewThread()`。把 draft 塞进 adapter 会产生以下问题：

- draft 需要伪 adapter ID；
- `mainThreadId`、`remoteId` 和 Desktop threadId 无法保持一致；
- rename/archive/delete capability 会错误地作用于草稿；
- create 失败后的 committed-thread 恢复会把 UI 带回旧 session；
- draft 可能被错误投影进 Sidebar。

因此草稿是 Desktop controller 的 view state，不是 assistant-ui thread-list item。

### 5.4 Composer 内容已有合适的所有者

assistant-ui composer 已持有：

- text；
- attachments；
- role；
- runConfig；
- quote / composer metadata。

Desktop reducer 不应复制这些数据。草稿 reducer 只保存目标 Project、只读配置快照、model/thinking 选择和提交阶段，Composer 内容继续由 `runtime.thread.composer` 持有。

### 5.5 draft 没有 SessionControlState

`SessionControlState` 是真实 Pi session 的控制面，包含 threadId、model、thinking、commands、readiness、queue 和 extension UI。draft 不得伪造该对象。

这不代表 draft 不能选择模型和 thinking。main 应提供不创建 `AgentSession` 的只读 `DraftSessionConfig`：使用与 session 创建相同的 `AuthStorage`、`ModelRegistry`、`SettingsManager` 和初始模型解析规则，返回可用模型、默认模型、对应 thinking levels 与 readiness。不得通过创建隐藏 session 获取这些数据。

因此 draft Composer：

- 显示 Project、Model 和 Thinking 选择器；
- 允许 text 和图片附件；
- 不显示 queue、SessionStatus 和 extension widgets；
- `/` command suggestions 展示资源加载阶段可发现的 extension、prompt 和 skill 命令；
- 在 `session_start` 中动态注册的命令仍需 materialize 后由真实 snapshot 补齐；
- `@` 文件建议只依赖选中的 Project，可以继续工作。

### 5.6 Project 选择与 Sidebar 展开相互独立

当前 Project row 的展开状态由 `ProjectList.expandedProjectIds` 管理，并会在传入的 active `projectId` 改变时自动展开。draft Project 只是首次创建 session 的目标，不是 Sidebar navigation state。

因此选择 draft Project：

- 不调用 `projects.open()`；
- 不调用 `sessions.list()`；
- 不修改传给 `ProjectList` 的 active `projectId`；
- 不触发 `onProjectExpand()`；
- 不 attach 或选择该 Project 的任何历史 thread。

只有用户显式展开 Project row，或首次 prompt 已成功 materialize 并成为 committed thread 后，Sidebar 才按普通导航语义更新。

### 5.7 committed thread 切换会重建 composer runtime

当前 `ExternalStoreThreadListRuntimeCore` 在 adapter `threadId` 从 `undefined` 变为真实 ID 时会重新创建 main thread runtime。`switchToNewThread()` 本身不会 reset composer，但随后提交真实 `threadId` 会让旧 draft composer 被替换。

因此 readiness 非 ready 时不能只依赖“未调用 `composer.reset()`”保留输入。实现必须在 materialize 前捕获可重放的 composer 数据，并在真实 thread runtime 生效后执行一次 reseed。

### 5.8 attach 已有 generation 隔离，但 detach 是全局操作

preload `sessions.attach()` 已使用 generation 和 attachment ID：stale attach 会以 `AbortError` 失败，并只 detach 自己返回的 attachment。`SessionEventBus.detach()` / `window.desktop.sessions.detach()` 则会清理 renderer 当前 attachment。

因此 stale materialize 分支：

- 依赖 preload attachment generation 隔离 stale subscription；
- 只按已知 `projectId/threadId` 调用 `sessions.remove()` 清理该次创建的 session；
- 不得无条件调用全局 `SessionEventBus.detach()`；
- 只有 generation 仍为当前提交且当前 attachment 确属该 session 时，才允许执行全局 detach/reset。

## 6. 核心术语

### 6.1 Draft

窗口级、renderer-only、尚未 materialize 的新会话输入状态。

### 6.2 Materialize

因用户提交首个 prompt 而执行的 create + attach。materialize 成功后 draft 转换为真实 Desktop thread。

### 6.3 Submit

用户通过发送按钮或 Composer 提交快捷键表达发送意图。只有非空 text 或至少一个有效附件时才是有效 submit。

### 6.4 Committed thread

已经由 main 创建、可从 session catalog 恢复、拥有真实 projectId/threadId 的 Pi session。

## 7. 状态模型

### 7.1 Renderer 状态

在 `DesktopState` 增加：

```ts
interface DraftSessionState {
  projectId: string | null;
  config: DraftSessionConfig | null;
  configLoading: boolean;
  phase: "editing" | "materializing";
}

interface DraftSessionConfig {
  models: ModelOption[];
  commands: SlashCommand[];
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: SessionControlState["thinkingLevel"];
  thinkingLevels: SessionControlState["thinkingLevels"];
  readiness: Readiness;
}

interface DesktopState {
  // existing fields
  draft: DraftSessionState | null;
}
```

不在 `DraftSessionState` 中保存：

- text；
- attachments；
- threadId；
- bootstrap / control / workbench；
- 临时 adapter ID。

### 7.2 状态不变量

当 `state.draft !== null` 时：

1. 对外 `threadId` 必须为 `null`；
2. 对外 `bootstrap`、`snapshot` 和 `workbench` 必须为 `null`；
3. thread adapter 的 `threadId` 必须为 `undefined`；
4. `ElectronPiAgent.attachedSession` 必须为空；
5. assistant-ui thread messages 必须为空；
6. `activeThreadIds[projectId]` 可以保留，用作以后恢复该 Project 的 committed thread；
7. draft 不得出现在 `threadCatalogs`。

`state.project` 继续表示 committed thread / Sidebar navigation 的 Project；`state.draft.projectId` 独立表示首次创建 session 的目标。二者允许不同，选择 draft Project 不得修改 `state.project`。Project 被移除后清空匹配的 draft target/config，直到用户重新选择 available Project。

### 7.3 Reducer actions

建议增加：

```ts
type DesktopAction =
  | { type: "draft-started"; projectId: string }
  | { type: "draft-project-selected"; projectId: string }
  | { type: "draft-config-loaded"; projectId: string; config: DraftSessionConfig }
  | { type: "draft-model-selected"; model: DraftSessionConfig["model"]; thinkingLevel: SessionControlState["thinkingLevel"]; thinkingLevels: SessionControlState["thinkingLevels"] }
  | { type: "draft-thinking-selected"; thinkingLevel: SessionControlState["thinkingLevel"] }
  | { type: "draft-materializing" }
  | { type: "draft-restored" }
  | { type: "draft-committed"; thread: Thread; bootstrap: SessionBootstrap; workbench: WorkbenchState }
  | { type: "draft-discarded" };
```

`draft-committed` 应与当前 `thread-created` 的 catalog/bootstrap/control/workbench 提交语义一致，并原子清除 draft。

## 8. 状态所有权

| 数据 | 所有者 | 是否持久化 |
| --- | --- | --- |
| draft 是否存在 | Desktop reducer | 否 |
| draft Project | Desktop reducer | 否，不修改 ProjectStore active Project |
| draft models/defaults/readiness/commands | main 只读 DraftSessionConfig + Desktop reducer cache | 否 |
| draft model / thinking 选择 | Desktop reducer | 否，首次 create 时原子传入 |
| draft text / attachments | assistant-ui composer | 否 |
| materializing single-flight | controller/runtime ref + reducer phase | 否 |
| readiness 失败后的 composer reseed | runtime/controller 一次性 ref | 否 |
| committed thread ID | SessionSupervisor / SessionManager | 是 |
| messages / run | Pi session + AG-UI runtime | 是 |
| model / thinking / readiness | SessionControlState | 是 |
| WorkbenchState | ProjectStore | 是，仅 committed thread |

## 9. 产品交互

### 9.1 进入新会话

Sidebar “新建任务”使用受控 primitive：

```text
ThreadListPrimitive.New click
  -> preventDefault
  -> desktop.beginDraft()
  -> detach current renderer attachment（不 abort Pi）
  -> clear assistant-ui thread messages
  -> enter draft state
  -> focus Composer
```

禁止在该流程调用：

- `runtime.threads.switchToNewThread()`；
- `window.desktop.sessions.create()`；
- `thread-created` reducer action。

当窗口已经处于 draft 时，再次点击“新建任务”只聚焦当前 Composer，不重置内容，也不创建第二个 draft。

### 9.2 默认 Project

`beginDraft()` 按以下顺序选择目标：

1. 当前 available Project；
2. `projects` 中最近打开的第一个 available Project；
3. 没有 available Project 时拒绝进入 draft，并引导用户添加 Project。

Sidebar New 的 disabled 条件改为“没有任何 available Project 或正在 materializing”，不再要求已经存在 active thread。

### 9.3 Project 选择

Project Select 只在 draft Composer 显示。

选择新 Project：

```text
ProjectSelect change
  -> desktop.selectDraftProject(projectId)
  -> 从 DesktopState.projects 校验 available Project
  -> reducer draft-project-selected
  -> sessions.getDraftConfig(projectId)
  -> reducer draft-config-loaded（仅接受最新 generation）
  -> 保留 Composer text 和 attachments
  -> 不 open/list/attach 任何已有 thread
```

约束：

- unavailable Project 必须 disabled；
- materializing 时 Select 必须 disabled；
- 选择含有历史 session 的 Project 也保持 draft，不自动打开第一条历史；
- 选择 Project 不展开、收起或激活对应 Sidebar Project row；
- 普通 committed thread Composer 不显示 Project Select；
- Project row 展开只加载 catalog，不改变 draft Project。

### 9.4 模型与 Thinking 选择

进入 draft 或切换 draft Project 后，renderer 调用只读 `sessions.getDraftConfig(projectId)`。该 API：

1. 读取 Project cwd，但不调用 `projects.open()`；
2. 构造与 `SessionRuntime.create()` 相同来源的模型与设置解析器；
3. 返回当前可用模型、默认模型、该模型支持的 thinking levels、readiness，以及资源加载阶段可发现的 commands；
4. 不创建 `SessionManager`、`AgentSession`、SessionRuntime、JSONL 或 catalog item。

选择模型只更新 draft config，并基于该模型重新计算 thinking levels；当前 thinking 不受支持时按 Pi 的 clamp 规则收敛。选择 thinking 只更新 draft config。两者均不调用现有 session 级 `setModel()` / `setThinking()`。

Project/config loading 或 readiness 非 ready 时禁用发送，但 Composer 输入保持可编辑。快速切换 Project 使用独立 config generation，旧 Project 返回的模型配置不得覆盖新选择。

### 9.5 空 Project

当启动或选择的 Project 没有 regular session 时，中央区域直接进入 draft Composer，不显示“先创建空会话”按钮。

当没有任何 Project 时，保留 Project onboarding 空状态，不渲染不可用 Composer。

### 9.6 离开草稿

首期只维护一个窗口级 draft。

- 打开 committed thread 会离开 draft；
- draft Composer 为空时直接丢弃；
- draft Composer 非空或含附件时，必须先确认丢弃；
- 窗口 reload/关闭不持久化 draft；
- 删除 draft 当前 Project 后保留输入，但清空 Project 选择并禁用发送，直到用户选择另一个 available Project。

## 10. Draft Composer

### 10.1 组件模式

Composer 使用显式联合类型，不伪造 snapshot：

```ts
type ComposerProps =
  | {
      mode: "draft";
      project: Project | null;
      config: DraftSessionConfig | null;
      configLoading: boolean;
      phase: DraftSessionState["phase"];
    }
  | { mode: "session"; snapshot: SessionControlState };
```

draft 模式显示：

- ProjectSelect；
- ModelSelect；
- ThinkingSelect；
- ComposerPrimitive.Input；
- 图片附件按钮与附件列表；
- 自定义 submit button。

session 模式保持：

- ModelSelect；
- ThinkingSelect；
- running queue mode；
- cancel/send；
- SessionStatus、commands 和 extension widgets。

### 10.2 禁止直接使用 ComposerPrimitive.Send

draft submit button 不能包在 `ComposerPrimitive.Send` 中。否则 primitive 会在 session materialize 前调用 composer `send()`，导致 detached `ElectronPiAgent` 报错。

draft form submit 必须：

1. 同步 `event.preventDefault()`；
2. 校验非空 text 或附件；
3. 调用唯一的 `desktop.submitDraft()`；
4. materializing 期间禁止重复提交。

draft Project 为空、config loading 或 readiness 非 ready 时 input 可以保留并继续编辑，但发送按钮和 Project 相关 suggestions 必须 disabled。materializing 时 Project、Model、Thinking、input、attachment 和 send 全部 disabled。Model/Thinking 控件使用 draft config，不调用 session 级 IPC。

### 10.3 Suggestions

`ComposerSuggestions` 应从 `SessionControlState` 解耦为最小输入：

```ts
interface ComposerSuggestionContext {
  projectId: string;
  commands: readonly SlashCommand[];
}
```

draft Project 非空时使用 `{ projectId, commands: config.commands }`：

- `@` 文件建议可用；
- `/` 展示资源加载阶段已注册的 extension、prompt 和 skill commands；
- materialize 后由真实 snapshot 恢复完整 commands，包括 `session_start` 中动态注册的命令。

draft Project 为空时不请求 suggestions。

## 11. 首个 Prompt 提交流程

### 11.1 分层职责

```text
Draft Composer
  -> desktop.submitDraft()
  -> DesktopThreadActions.submitDraft(project)
  -> prepare composer submission
  -> capture draft model + thinking
  -> runtime.threads.switchToNewThread()
  -> adapter.onSwitchToNewThread()
  -> sessions.create({ projectId, model, thinkingLevel }) + atomic attach
  -> ElectronPiAgent.attach(bootstrap)
  -> readiness branch
  -> append first user message / start AG-UI run
  -> reducer draft-committed
```

业务组件不得自行拼接 `SessionRunInput`，也不得直接调用 `sessions.create()`。

### 11.2 Prepare 阶段

在创建 session 前读取 composer state，并完成所有可能失败的纯输入准备：

1. 捕获 text、role、runConfig 和 attachments；
2. trim 只用于判断是否为空，不应擅自改写用户正文；
3. 等待 pending 图片附件转换为 complete attachments；
4. 附件格式或读取失败时停止流程；
5. 不 reset composer。

Prepare 返回两个同源产物：

```ts
interface PreparedComposerSubmission {
  message: CreateAppendMessage;
  reseed: ComposerReseed;
}

interface ComposerReseed {
  text: string;
  role: ThreadComposerState["role"];
  runConfig: ThreadComposerState["runConfig"];
  quote: ThreadComposerState["quote"];
  attachments: readonly CreateAttachment[];
}
```

`message` 用于 append，`reseed` 只用于 readiness 非 ready 后恢复新 runtime 的 Composer。pending attachments 必须先转换为 complete content，再同时生成 message attachments 与可传给 `composer.addAttachment()` 的 `CreateAttachment`，避免 reseed 再次读取原始文件。

Prepare 失败必须满足：

- `sessions.create()` 调用次数为 0；
- draft 保持 editing；
- text 和附件保持不变；
- 错误显示在 Composer，并同步进入 Desktop error surface。

### 11.3 Materialize 阶段

Prepare 成功后：

1. 设置 `phase = materializing`；
2. 分配 switch generation；
3. 调用 `runtime.threads.switchToNewThread()`；
4. adapter 调用 `sessions.create({ projectId, model, thinkingLevel })`；
5. 通过现有原子 `SessionEventBus.attach()` 获取 bootstrap；
6. attach `ElectronPiAgent`；
7. 获取该 thread 的 WorkbenchState；
8. 返回 `PreparedThread`，但暂不把 draft 投影进 catalog。

`sessions.create()`、attach 和 Workbench hydrate 对同一 submit 必须 single-flight。main 必须验证所选模型仍然存在且可用，并把显式 model/thinking 直接传给 `createAgentSession()`；不得先按默认值创建后再调用 `setModel()` / `setThinking()`，也不得在显式模型失效时静默 fallback 到另一个模型。

### 11.4 Readiness 分支

draft config 提供提交前 readiness；非 ready 时不得进入 materialize。create/attach 后的 bootstrap 仍是权威状态，因此还需处理配置查询与创建之间发生凭据或模型变化的竞态。

如果 `prepared.bootstrap.control.readiness.state !== "ready"`：

1. 不发送 prompt；
2. 把 `ComposerReseed` 写入一次性 ref，再提交真实 thread 到 reducer；
3. 该真实 thread 保持 committed，因为用户已经执行了真实 submit；
4. 等 adapter `threadId` 变为该真实 thread、main thread runtime 重建后，按 `setText`、`setRole`、`setRunConfig`、`setQuote`、`addAttachment` 恢复 Composer；
5. reseed 成功后清除一次性 ref，不得在后续 thread 切换中重复恢复；
6. 显示真实 session 的 ModelSelect、ThinkingSelect 和 readiness error；
7. 用户修复模型后再次发送，沿用普通 committed-thread 流程；
8. 不再次创建 session。

这满足“只有真实发送意图才创建 session”，同时避免为了读取模型状态提前创建隐藏 session。

### 11.5 Send 阶段

readiness 为 ready 时：

1. 使用 prepare 阶段捕获的标准 assistant-ui user message；
2. 通过稳定 `runtime.thread` 公共 API append；
3. 让 `ElectronPiAgent` 向同一 projectId/threadId 发起 AG-UI run；
4. reset composer；
5. 返回 `PreparedThread`；
6. controller 执行 `draft-committed`。

不得在 create 后重新读取 Composer，防止 materializing 期间的输入变化进入错误 session。materializing 期间 input、附件和 Project Select 应 disabled。

### 11.6 提交点

产品提交点是“首个 user message 已交给 attached runtime”，不是 `sessions.create()` resolve。

renderer thread catalog 只能在以下任一条件成立后增加新 thread：

- readiness 不可用，已转入可配置的真实 session；
- 首个 user message 已 append 到 attached runtime。

## 12. 错误与恢复

### 12.1 Create / attach 失败

- 不提交 thread catalog；
- 不清空 Composer；
- `phase` 回到 editing；
- runtime 回到 detached empty thread，不恢复旧 committed thread UI；
- draft Project 保持不变；
- 可重试 submit。

进入 draft 时，旧 committed thread 只保留在 `activeThreadIds` cache。create 失败不得自动退出 draft 或显示旧消息。

### 12.2 Append 前同步失败

如果 session 已创建，但首个 message 尚未交给 runtime 就发生同步失败：

1. 调用 `sessions.remove(projectId, threadId)` 清理新 runtime；
2. 仅当该提交 generation 仍是当前 generation 时 detach/reset 当前 attachment；stale generation 依赖 preload token 清理自己的 attachment，禁止调用全局 detach；
3. 回到 draft editing；
4. 保留 Composer 内容；
5. 不更新 catalog。

### 12.3 Run 异步失败

首个 user message 已 append 后发生 provider、tool 或 AG-UI run error：

- session 保持 committed；
- user message 与错误状态保留；
- 不回滚为 draft；
- 沿用普通 session retry/error 语义。

这是一次已经实际发送的 prompt，不属于 materialize 失败。

### 12.4 快速操作

- 双击发送：只允许第一个 submit 进入 materializing；
- materializing 时点击 New：忽略并聚焦当前 Composer；
- materializing 时点击 thread：禁用或等待提交 settle，不允许并行 attach；
- stale generation：清理其创建的未提交 session，不得覆盖新 selection；
- window close：main 按现有 owner/attachment 清理订阅，未提交 runtime 应 dispose。

## 13. Runtime API 调整

### 13.1 DesktopContext commands

建议替换：

```ts
createThread(): Promise<void>;
```

为：

```ts
beginDraft(): Promise<void>;
selectDraftProject(projectId: string): Promise<void>;
selectDraftModel(provider: string, modelId: string): void;
selectDraftThinking(level: SessionControlState["thinkingLevel"]): void;
submitDraft(): Promise<void>;
discardDraft(): Promise<void>;
```

`submitDraft()` 必须向 Composer 返回可显示的错误，不能只在 controller 内吞掉异常。

### 13.2 Main / preload draft config 与 create input

建议增加：

```ts
interface SessionCreateInput {
  projectId: string;
  model: { provider: string; id: string };
  thinkingLevel: SessionControlState["thinkingLevel"];
}

sessions.getDraftConfig(projectId: string): Promise<DraftSessionConfig>;
sessions.create(input: SessionCreateInput): Promise<SessionBootstrap>;
```

`getDraftConfig()` 是只读配置查询，不得改变 ProjectStore active Project 或 session catalog。模型默认值、thinking clamp 和静态 command discovery 必须复用 Pi 创建路径的资源与解析规则，不能在 renderer 复制一套 fallback。

当前 `@earendil-works/pi-coding-agent` 公共入口导出了 `ModelRegistry`、`SettingsManager` 和 CLI model resolver，但没有导出 SDK 内部使用的完整初始模型解析函数。实施时应先把“解析可用模型、默认模型与 thinking”的逻辑提取为 coding-agent 公共只读 helper，并让 `createAgentSession()` 与 Desktop `getDraftConfig()` 共同调用；不得从 `node_modules` 私有路径导入，也不得在 Desktop 复制 fallback 顺序。

### 13.3 DesktopThreadActions

建议将：

```ts
create(project: Project): Promise<PreparedThread>;
```

替换为：

```ts
enterDraft(): Promise<void>;
submitDraft(input: { project: Project; model: { provider: string; id: string }; thinkingLevel: SessionControlState["thinkingLevel"] }): Promise<PreparedDraftSubmission>;
discardDraft(): Promise<PreparedThread | null>;
```

其中使用判别联合约束 `sent` 与 `reseed`：

```ts
type PreparedDraftSubmission =
  | (PreparedThread & { sent: true })
  | (PreparedThread & { sent: false; reseed: ComposerReseed });
```

`sent = false` 只允许表示 materialize 成功但 readiness 非 ready。

`reseed` 只能由匹配 `projectId/threadId` 的 committed runtime 消费一次。

### 13.4 Thread adapter

`UseAgUiThreadListAdapter.onSwitchToNewThread()` 保留 create + attach 实现，但调用点从 New button 移到 `DesktopThreadActions.submitDraft()`。

adapter 不感知 DraftSessionState，也不返回草稿 metadata。

## 14. 组件调整

预计涉及：

- `components/layout/sidebar.tsx`
  - New 改为 `beginDraft()`；
  - draft active/pending 样式；
  - 离开非空 draft 的确认。
- `components/chat/chat-thread.tsx`
  - draft 使用空消息 viewport + Composer；
  - 无 Project 时保留 onboarding；
  - 不再用“创建第一个会话”按钮提前创建 session。
- `components/chat/composer.tsx`
  - draft/session discriminated props；
  - draft 自定义 submit；
  - ProjectSelect 只在 draft 分支；
  - materializing disabled 状态。
- `components/chat/composer-controls.tsx`
  - 增加 draft-only ProjectSelect；
  - 让 ModelSelect/ThinkingSelect 接受 draft/session 判别输入。
- `components/chat/composer-suggestions.tsx`
  - 改为最小 suggestion context。
- `state/desktop-model.ts`
  - DraftSessionState 与 reducer actions。
- `state/use-desktop-controller.ts`
  - begin/select/config generation/model/thinking/submit/discard orchestration。
- `runtime/use-pi-runtime.ts`
  - enterDraft、prepare、materialize、append、cleanup。

预计增加最小 main/preload 合约：

- draft config 只读查询；
- 带显式 model/thinking 的 session create input。

默认不修改：

- main `SessionSupervisor` 的 attach 基本合约与 session 生命周期；
- preload attachment token 协议；
- `ElectronPiAgent` 的 run transport；
- Pi JSONL 与 SessionManager；
- 归档 UI。

如果实现证明未提交 runtime 无法在 stale generation 中可靠清理，可以新增 main 的 request token 或 create-abort IPC，但必须先更新本规范。

## 15. 分阶段实施计划

### 阶段一：状态模型

- 增加 DraftSessionState；
- 增加 begin/select/discard reducer actions；
- 增加 draft config/model/thinking actions；
- 让 draft 派生的 threadId/bootstrap/snapshot/workbench 为空；
- 保留 activeThreadIds cache。

### 阶段二：Runtime 草稿边界

- New 与 `switchToNewThread()` 解耦；
- 增加 enterDraft 与 submitDraft；
- 增加不创建 session 的 draft config 查询；
- 实现附件 prepare；
- 实现显式 model/thinking create + attach single-flight；
- 实现 readiness 分支、composer reseed 与 create 后清理。

### 阶段三：Composer UI

- 渲染 draft Composer；
- ProjectSelect 仅在 draft；
- ModelSelect/ThinkingSelect 同时支持 draft config；
- draft submit 不使用 ComposerPrimitive.Send；
- materializing 禁用编辑；
- suggestion context 解耦。

### 阶段四：切换与丢弃保护

- 非空 draft 离开确认；
- New 在 draft 中幂等；
- thread/project 快速切换 generation；
- stale materialize cleanup。

### 阶段五：验证与规范同步

- 增加 focused tests；
- 更新 thread attach/list spec 的新建流程和实现状态；
- 运行根级检查。

## 16. 测试要求

### 16.1 Reducer

- `draft-started` 不修改 threadCatalogs；
- draft 保留原 Project 的 activeThreadIds；
- draft 派生 snapshot/workbench/threadId 为空；
- draft Project 切换不打开历史 thread；
- draft Project 切换不改变 Sidebar active/expanded Project；
- draft model/thinking 选择不创建 session；
- `draft-committed` 原子增加 thread 并清除 draft；
- discard 恢复到明确的 none/thread selection。

### 16.2 Controller / runtime

- 点击 New 的 `sessions.create` 调用次数为 0；
- 重复点击 New 仍只有一个 draft；
- draft Project change 不 attach、不 create；
- draft Project change 不调用 `projects.open()` / `sessions.list()`；
- draft config 查询不创建 SessionRuntime/SessionManager；
- draft config 包含资源加载阶段可发现的全局 extension、prompt 和 skill commands；
- 首次 create 收到准确的 Project/model/thinking；
- 首次 submit 只 create 一次、attach 一次、run 一次；
- 双击 submit 不创建两个 session；
- attachment prepare 失败时不 create；
- create/attach 失败保留 Composer 内容；
- readiness 非 ready 时 create 一次、不 run、保留输入；
- readiness 非 ready 的 committed `threadId` 生效后完整 reseed text、attachments、role、runConfig 和 quote；
- readiness 修复后的发送不再次 create；
- append 前同步失败清理新 session；
- run 异步失败保留 committed session；
- stale materialize 不覆盖最新 selection；
- stale materialize 只 remove 自己创建的 session，不 detach 当前 attachment。

### 16.3 UI

- ProjectSelect 只在 draft Composer 可见；
- draft Composer 显示 ModelSelect 与 ThinkingSelect；
- draft Project 选择不展开 Project row；
- committed 空历史 thread 也不显示 ProjectSelect；
- materializing 时 ProjectSelect、ModelSelect、ThinkingSelect、input、attachment 和 send disabled；
- no Project onboarding 不创建 draft；
- 空 Project 自动显示 draft Composer；
- 非空 draft 离开前显示确认；
- draft 不出现在 Sidebar Items。

“committed 空历史 thread 不显示 ProjectSelect”是必要回归测试：显示条件必须来自 Desktop draft 状态，不能使用 `thread.isEmpty` 或 `messages.length === 0` 推断。

### 16.4 验收命令

修改或新增测试后，从 `packages/desktop` 运行具体测试：

```sh
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

最后从仓库根运行：

```sh
npm run check
```

不运行 `npm test` 或 build。

## 17. 验收标准

1. 点击“新建任务”不会调用 `sessions.create()`。
2. draft 没有 threadId、bootstrap、snapshot、WorkbenchState 或 catalog item。
3. ProjectSelect 只由 `DesktopState.draft` 控制，不根据消息数量推断。
4. committed thread 即使 messageCount 为 0，也不显示 ProjectSelect。
5. draft Project 选择不调用 `projects.open()` / `sessions.list()`，不改变 Project row 展开状态。
6. draft 显示模型、thinking 与静态可发现 commands，且选择过程不创建 session。
7. 首个有效 submit 恰好创建一个 session，并把选定 Project/model/thinking 原子应用到同一 attached runtime。
8. prepare/create/attach 失败不丢失 draft 输入或附件。
9. readiness 非 ready 不产生第二个 session，用户可在 materialize 后配置并重发。
10. materializing 期间没有重复 create、并行 attach 或 Project 漂移。
11. draft 不进入 thread adapter arrays，不使用伪 ID。
12. 既有 thread attach、active run join、queue、cancel 和 Workbench 行为不回归。
13. 归档行为不因本规范发生变化。
14. focused tests 与 `npm run check` 通过。

## 18. 风险与后续决策

### 18.1 草稿持久化

首期 draft 是窗口内存状态，reload/退出会丢失。若后续要求恢复草稿，应建立独立的 draft persistence，不得复用 Pi session 文件或创建空 session。

### 18.2 多草稿

首期只支持一个窗口级 draft。多 Project 草稿需要独立 draft ID、Composer state 存储和 Sidebar 产品形态，应另行设计。

### 18.3 Draft model selector

draft 必须显示 model/thinking 和资源加载阶段可发现的 commands，但只持有最小 `DraftSessionConfig`，不伪造 `SessionControlState`。配置查询与首次 create 必须复用同一 Pi 模型及资源解析语义；依赖 `session_start` 的动态命令只在 materialize 后出现，仍不得通过隐藏 session 获取列表。

### 18.4 Main 原子 create-and-run

首期沿用 renderer 的 create + atomic attach + append。如果故障注入证明 create 后、append 前的清理不能可靠关闭窗口，应增加 main request token 或原子 create-and-run 合约；该变更必须保持 AG-UI runtime 为消息生命周期入口。

## 19. 实现状态

- `DraftSessionState` 独立保存目标 Project、只读 model/thinking config 和 materializing phase；
- draft Project 选择只查询 `sessions.getDraftConfig()`，不调用 `projects.open()` / `sessions.list()`，也不改变 Sidebar active Project；
- coding-agent 公共导出 `findInitialModel()` 与 `resolveThinkingConfiguration()`，Desktop preview 和真实 session 创建复用同一模型语义；
- draft config 通过 Pi session services 发现全局 extension、prompt 和 skill commands，Composer 在 materialize 前即可补全静态命令；
- `sessions.create()` 接受显式 `SessionCreateInput`，在 `createAgentSession()` 构造阶段原子应用 model/thinking；
- Composer 的 ProjectSelect 仅在 draft 显示，ModelSelect/ThinkingSelect 同时支持 draft 与 committed session；
- prepare 成功后才进入 materializing，create/attach 失败保留 Composer，重复 submit 由 single-flight 隔离；
- Desktop 9 个定点测试文件共 41 个测试、coding-agent model-resolver 42 个测试通过；根级 `npm run check` 通过。

## 20. 参考

- [Desktop assistant-ui Thread Adapter 与原子 Attach 规范](./assistant-ui-thread-attach-spec.md)
- [Desktop assistant-ui ThreadList Primitives 集成规范](./assistant-ui-thread-list-primitives-spec.md)
- [`usePiRuntime`](../src/renderer/src/runtime/use-pi-runtime.ts)
- [`useDesktopController`](../src/renderer/src/state/use-desktop-controller.ts)
- [`Composer`](../src/renderer/src/components/chat/composer.tsx)
- [`SessionSupervisor.create`](../src/main/pi/session-supervisor.ts)
- [`SessionRuntime.create`](../src/main/pi/session-runtime.ts)
- [`UseAgUiThreadListAdapter`](../../../node_modules/@assistant-ui/react-ag-ui/src/runtime/types.ts)
- [`ExternalStoreThreadListRuntimeCore`](../../../node_modules/@assistant-ui/core/src/runtimes/external-store/external-store-thread-list-runtime-core.ts)
- [`ComposerRuntime`](../../../node_modules/@assistant-ui/core/src/runtime/api/composer-runtime.ts)
