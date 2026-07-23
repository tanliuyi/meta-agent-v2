# Desktop Pi-native assistant-ui External Store Runtime 规范

状态：Implemented
最后更新：2026-07-17

## 1. 摘要

Desktop 消息链路从 `@assistant-ui/react-ag-ui` 重构为 Pi-native timeline，并使用 assistant-ui `useExternalStoreRuntime()` 作为唯一 chat runtime。

目标链路：

```text
Pi AgentSession / SessionManager
  -> Desktop PiCompatibilityAdapter
  -> PiThreadProjector
  -> PiThreadSnapshot + PiThreadEventBatch
  -> Electron attachment IPC
  -> PiThreadStore
  -> memoized ThreadMessage repository converter
  -> useExternalStoreRuntime
  -> Thread / Message / Composer primitives
```

本规范的最高优先级约束是：

1. `packages/ai`、`packages/agent`、`packages/coding-agent` 以及发布的 `@earendil-works/pi-coding-agent` 均视为上游只读实现。
2. 不修改 Pi 源代码、公共 API、事件顺序、queue 行为、session tree 行为或 `session.jsonl` 格式与语义。
3. Desktop 必须适配 Pi，而不是要求 Pi 适配 assistant-ui。
4. Pi 已公开的能力必须完整映射；Pi 未公开的能力不得通过文本猜测、重排队列、改写 JSONL 或 renderer-only history 伪造。
5. 上游 API 不满足本规范依赖时必须 fail fast，并给出明确的不兼容诊断，禁止静默降级。

## 2. 背景

Pi 的一次 agent run 可以包含多轮消息：

```text
user A
assistant B
tool calls / tool results
user steer C
assistant D
user follow-up E
assistant F
agent_settled
```

`@assistant-ui/react-ag-ui` 把一次 AG-UI run 聚合为一条 assistant-ui assistant message，无法稳定表达 Pi run 内多条独立 user/assistant message。现有实现因此需要 consumed-user custom event、合成 run/step 边界和 terminal snapshot 校正。

这些 workaround 把 Pi 消息模型伪装成 AG-UI run 模型，导致 live、reattach 和 settle 后的顺序不一致。本规范删除该中间语义层，由 Desktop 直接投影 Pi timeline。

## 3. 与现有规范的关系

### 3.1 被取代的范围

实现完成后，本规范取代：

- [Desktop AG-UI 集成规范](./ag-ui-integration-spec.md)中的消息数据面、`PiAgUiAdapter`、`ElectronPiAgent` 和 active-run replay；
- [Desktop assistant-ui Thread Adapter 与原子 Attach 规范](./assistant-ui-thread-attach-spec.md)中的 `UseAgUiThreadListAdapter`、AG-UI bootstrap、history import 和 active run join。

旧文档应标记为 `Superseded` 并链接到本规范。

### 3.2 继续有效的产品语义

以下设计继续有效：

- Project 分组、thread rename/archive/delete 和受控 ThreadList primitives；
- renderer-only draft，首次有效提交时才创建 Pi session；
- Project/model/thinking 的显式选择；
- attachment prepare、失败 reseed；
- attachment token、preload pending buffer、generation 和 stale attach 隔离；
- HostUi、extension UI、Workbench、terminal/files；
- Pi session catalog 与现有 JSONL append-only tree。

### 3.3 当前 workaround

当前工作区中 consumed user message 插入、合成 `RUN_FINISHED` / `RUN_STARTED` 和 step 重开仅用于验证问题。迁移时必须删除，不能成为兼容层。

### 3.4 规范优先级

本规范的 Pi 只读约束高于被引用旧规范中的实施建议。旧规范若要求修改 `packages/ai`、`packages/agent`、`packages/coding-agent`、增加 Pi public helper、改变 queue/session tree 行为或扩展 JSONL，相关建议自动失效；实现必须改为只使用当前已发布根导出的 Desktop 适配方案，或明确标记为上游暂不支持。

“完整适配”指完整保留和呈现 Pi 当前公开语义，不表示 Desktop 可以补造 Pi 没有公开的能力。无法从 Pi public surface 无歧义观察或执行的行为，必须在 capability/UI 中关闭并在兼容矩阵中记录，不能用近似实现冒充支持。

## 4. 目标

1. 完整表达 Pi 当前 active branch 上的可见 timeline。
2. 每条 Pi user、assistant、bash、compaction summary、branch summary 和 displayable custom message 保持独立身份。
3. tool result 折叠到所属 assistant tool-call part，不生成伪 user/assistant turn。
4. steer/follow-up 只在 Pi 实际消费时进入正式 timeline；pending 状态由 queue surface 表达。
5. Pi 的 extension command、input hook、template/skill expansion、queue mode、retry、compaction 和 tree navigation 语义不被 Desktop 绕过。
6. bootstrap 直接包含当前完整可见状态，不 replay AG-UI event log。
7. 普通 delta payload 与完整历史长度无关。
8. renderer resync 原子替换 snapshot，不重建 React tree 或 runtime。
9. assistant-ui capability 与 Pi 实际能力严格一致。
10. 不修改 Pi 源码和 session persistence。

## 5. 非目标

本规范不要求：

- 给 Pi queue 增加 ID、remove、promote 或持久化；
- 修改 `AgentSessionEvent`、`SessionEntry` 或 JSONL schema；
- 从 Desktop 重现 Pi 私有 queue、agent-loop 或 extension-runner 逻辑；
- 让 assistant-ui BranchPicker 直接修改 Pi tree；
- 引入 HTTP、SSE、WebSocket、Assistant Cloud 或 AI SDK transport；
- 支持多个窗口同时编辑同一 Pi session；
- 为旧 AG-UI API 增加双写或兼容层。

## 6. Source of truth

| 领域 | 权威来源 | Desktop 行为 |
| --- | --- | --- |
| 持久化 entry identity/tree | `SessionManager.getBranch()` / `SessionEntry.id,parentId` | 只读投影，不生成替代持久化 ID |
| LLM context | `SessionManager.buildSessionContext()` / `AgentSession` | 不由 renderer 重建或回传 |
| live message/tool/phase | `AgentSessionEvent` | projector 增量投影 |
| queue truth | `queue_update`、`getSteeringMessages()`、`getFollowUpMessages()` | 瞬态镜像，不写 JSONL |
| queue consumption | Pi 发出的 user/custom `message_start` | 此时才加入正式 timeline |
| branch mutation | `AgentSession.navigateTree()` | typed Desktop command 调用 |
| retry/compaction/cancel | `AgentSession` 公共方法与事件 | 按 phase 调用对应公共 API |
| extension host | `desktop-controlled-extensions-spec.md` 定义的 Host Profile | 只支持声明式 UI；Composer 仅接收单向 replace/append command |
| assistant-ui state | `PiThreadStore` 的 memoized repository view | UI facade，不成为业务权威 |

禁止使用：

- `node_modules` 私有 subpath；
- Pi private field、private queue 或 agent-loop 内部对象；
- renderer 数组位置作为持久化 message identity；
- 文本去重决定消息是否存在；
- JSONL sidecar metadata 或格式扩展；
- `thread.import()` 修正 backend history。

## 7. 上游兼容边界

Desktop 只依赖 `@earendil-works/pi-coding-agent` 根导出的公共能力。adapter 初始化时验证所需 surface：

```ts
type RequiredPiSurface = Pick<
  AgentSession,
  | "isStreaming"
  | "prompt"
  | "sendUserMessage"
  | "abort"
  | "clearQueue"
  | "getSteeringMessages"
  | "getFollowUpMessages"
  | "navigateTree"
  | "compact"
  | "abortCompaction"
  | "abortBranchSummary"
  | "subscribe"
  | "sessionManager"
>;
```

同时验证 `session.sessionManager` 的公开 `getLeafId()`、`getBranch()`、`getEntry()` 和 `getLabel()`。所有类型从 `@earendil-works/pi-coding-agent` 根导出的 `AgentSession`、`SessionManager` 和 `VERSION` 推导，不重新声明 Pi 参数或返回类型，不读取 package 私有路径。类型检查是第一道约束；运行时若升级后的包缺失必需方法，SessionRuntime 创建必须抛出 `UnsupportedPiCodingAgentError`，错误中包含缺失能力与根导出的版本。禁止提供空 callback 或兼容假实现。

运行时校验同时覆盖 `isStreaming` 的 boolean property 和 `sessionManager` 对象本身；缺失属性不得先以普通 `TypeError` 泄漏。即使 reload 当前使用等价的 `prompt(...expandPromptTemplates:false)`，`sendUserMessage` 仍属于本适配版本锁定的 Pi public surface，升级时必须通过 characterization。

projector 对 `AgentSessionEvent`、`SessionEntry`、`AgentMessage.role`、assistant content part 和 stop reason 使用穷尽 switch。编译期新增 union member必须报错；运行时收到未知 discriminator 必须停止当前 batch 并进入 19.3，不得 default-ignore。这样上游新增语义时 Desktop 会显式阻断，而不是静默丢失。

## 8. 目标架构

```text
Main process

AgentSession + SessionManager
  -> PiCompatibilityAdapter
       commands: prompt/cancel/compact/navigateTree/clearQueue
       reads: branch/queue/control
  -> PiThreadProjector
       persisted branch projection
       live overlay
       tool folding
       transient queue mirror
       sequence/batching
  -> SessionRuntime
  -> SessionSupervisor attachment publisher

Renderer process

preload sessions.attach()
  -> attachment token buffer
  -> PiSessionBus
  -> PiThreadStore
  -> buildAssistantMessageRepository()
  -> usePiExternalRuntime()
       useExternalStoreRuntime()
       ExternalStoreThreadListAdapter
       ExternalThreadQueueAdapter
       command coordinator
  -> AssistantRuntimeProvider
```

### 8.1 模块职责

| 模块 | 职责 | 禁止承担 |
| --- | --- | --- |
| `PiCompatibilityAdapter` | 封装 Pi 公共 API、兼容校验 | 复制 Pi 私有逻辑 |
| `PiThreadProjector` | branch/live/tool/queue -> Desktop timeline | IPC、React、assistant-ui 类型 |
| `SessionRuntime` | 生命周期、commands、control/projector 协调 | UI message 转换 |
| `SessionSupervisor` | runtime single-flight、attachment、定向 publish | 消息内容解析 |
| preload | token、pending buffer、typed forwarding | reducer、消息转换 |
| `PiThreadStore` | snapshot/event apply、sequence、索引 | Pi 原始事件解析 |
| repository converter | timeline -> assistant-ui `ThreadMessage` repository | Pi command、IPC |
| `usePiExternalRuntime` | assistant-ui adapter、capability、command coordinator | 第二份历史 |
| components | 展示和受控交互 | 直接读取 Pi/IPC payload |

## 9. Shared timeline 数据模型

协议使用实施时下一个未占用的不兼容版本，不在文档中预占固定整数。实现时由 shared contract 导出唯一 `PROTOCOL_VERSION` 常量，以下类型均引用该常量。

### 9.1 Timeline node

```ts
interface PiTimelineNodeBase {
  id: string;
  parentId: string | null;
  sourceEntryId?: string;
  createdAt: number;
  label?: string;
}

type PiTimelineNode = PiUserMessage | PiAssistantMessage | PiNoticeMessage;
type JsonObject = { [key: string]: JsonValue };

interface PiUserMessage extends PiTimelineNodeBase {
  kind: "user";
  content: PiUserContentPart[];
  delivery:
    | { state: "live"; requestId?: string; queueId?: string }
    | { state: "persisted" };
}

interface PiAssistantMessage extends PiTimelineNodeBase {
  kind: "assistant";
  content: PiAssistantPart[];
  status: PiAssistantStatus;
  provenance: {
    api: string;
    provider: string;
    model: string;
    responseModel?: string;
    responseId?: string;
  };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  diagnostics?: JsonValue;
}

interface PiNoticeMessage extends PiTimelineNodeBase {
  kind: "notice";
  noticeType: "bash" | "custom" | "compaction" | "branch-summary";
  title: string;
  content: PiNoticeContent;
  metadata?: JsonValue;
}

type PiNoticeContent =
  | { type: "text"; text: string }
  | {
      type: "command";
      command: string;
      output: string;
      exitCode?: number;
      cancelled: boolean;
      truncated: boolean;
      fullOutputPath?: string;
      excludeFromContext?: boolean;
    }
  | {
      type: "custom";
      customType: string;
      content: PiUserContentPart[];
      details?: JsonValue;
    };
```

### 9.2 持久化 identity

- `SessionEntry.id` 是持久化 node 的 `id` 和 `sourceEntryId`。
- `SessionEntry.parentId` 可能指向 model/thinking/label 等非可见 entry；projector 必须沿 parent chain 找到最近可见 ancestor。
- live message 在持久化前使用 projector-local transient ID。
- projector 通过公开 `SessionManager.getBranch()` 的增量 persistence checkpoint 发现 canonical entry，随后发布 `node-rekeyed`，原子更新 node ID、children parent、tool owner 和 live request association。
- transient ID 仅存在于当前 main 进程，不进入 JSONL。

普通 user/assistant/toolResult/custom message 持久化不会发 `entry_appended`；该事件只覆盖 extension `appendEntry` 的 custom storage。live -> entry association 优先使用新 branch entry 中的同一 `AgentMessage` 对象引用和 projector 的 pending-persistence FIFO。只有对象引用因上游 replacement 丢失时才使用 role/content/timestamp 复核；多个候选无法唯一确定必须触发 snapshot rebuild，不能任选一个 rekey。

禁止用 timestamp + role 作为首选持久化 identity。timestamp 只用于没有 entry association 时的受控诊断 fallback；fallback 发生必须记录结构化 warning。

### 9.3 可见 entry 映射

| Session entry/message | Timeline |
| --- | --- |
| user message | `PiUserMessage` |
| assistant message | `PiAssistantMessage` |
| toolResult message | 折叠到 owner assistant tool part |
| bashExecution message | `PiNoticeMessage(noticeType="bash")` |
| custom message `display=true` | `PiNoticeMessage(noticeType="custom")` |
| custom message `display=false` | 不显示，但保留 parent traversal |
| compaction entry | `PiNoticeMessage(noticeType="compaction")` |
| branch_summary entry | `PiNoticeMessage(noticeType="branch-summary")` |
| model/thinking/label/session_info | control/catalog，不生成 chat bubble |
| extension custom storage entry | 不进入 timeline |

Timeline 展示 active append-only branch，来源是 `getBranch()`；不得用 `buildSessionContext()` 替代 UI 历史，因为后者是 compaction-aware LLM context，不是完整 session tree 展示。

Label entry 不生成 bubble，但 projector 必须按 Pi 当前 label resolution 把 label 附加到目标 node，供 Pi-native tree UI 和 message metadata 使用。

字段投影必须保留用户可观察语义：assistant 的 model/provider/usage/diagnostics、bash 的 `excludeFromContext`、custom message 的 text/image/details、compaction/branch summary 的 `details/fromHook/fromId/tokensBefore` 均经 JSON-safe allowlist 进入 node 或 metadata。opaque reasoning signature、tool thought signature、provider raw request/response 和 credentials 不进入 renderer。

### 9.4 Content parts

```ts
type PiUserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type PiAssistantPart =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | PiToolCallPart;

interface PiToolCallPart {
  id: string;
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  argsText: string;
  execution: "streaming-args" | "waiting" | "running" | "complete" | "error";
  partialResult?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
}
```

reasoning `redacted=true` 时不投影明文；opaque signature 不进入 renderer。

### 9.5 Assistant status

```ts
type PiAssistantStatus =
  | { type: "running" }
  | { type: "complete"; reason: "stop" | "unknown" }
  | {
      type: "incomplete";
      reason: "cancelled" | "length" | "error" | "other";
      error?: JsonValue;
    };
```

Pi `AssistantMessage.stopReason` 必须穷尽映射，不解析 `errorMessage` 文本猜测原因：

| Pi stopReason | tool lifecycle 终结后的 assistant-ui status |
| --- | --- |
| `stop` | `complete/stop` |
| `toolUse` | `complete/unknown` |
| `length` | `incomplete/length` |
| `aborted` | `incomplete/cancelled` |
| `error` | `incomplete/error`，携带脱敏后的结构化错误 |

含 `toolUse` 的 assistant message 在 tool lifecycle 结束前保持 running，最终在对应 `turn_end` 转为 complete。当前 Pi 没有独立 `content-filter` stop reason，Desktop 不得从错误字符串推断该状态；上游 stop reason union 增加成员时 compatibility test 必须先失败。

### 9.6 图片与 attachment

Pi 持久化图片只有 base64 data 与 MIME，不保存原始文件名或 Desktop attachment ID。因此：

- timeline 权威数据只保留 Pi image content；
- converter 为每个 image 生成确定性 complete attachment：`${messageId}:image:${contentIndex}`；
- name 使用 MIME 派生的稳定名称，例如 `image-1.png`；
- attachment 设置 `type: "image"`、`contentType: mimeType`、`status: { type: "complete" }`，content 只含对应 data URI image part；
- 图片只进入 assistant-ui attachment content，不同时复制为顶级 image part；
- Composer 发送前可以显示本地原始文件名，但发送后的历史不承诺保留该名称；
- 不为恢复文件名修改 JSONL 或增加 sidecar。

### 9.7 Queue snapshot

```ts
interface PiQueueItem {
  id: string;
  mode: "steer" | "followUp";
  prompt: string;
  source: "desktop" | "pi-observed";
  requestId?: string;
  createdAt?: number;
}
```

Queue item 是 Desktop 对 Pi 当前内存 queue 的瞬态镜像：

- 不包含 `messageId`；
- 不进入正式 timeline；
- 不持久化；
- main 重启后不恢复，因为 Pi queue 本身也不恢复；
- duplicate text 通过 mode 内有序 occurrence 区分，不能按文本集合去重。

### 9.8 Thread snapshot

```ts
interface PiThreadSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  cursor: number;
  headId: string | null;
  nodes: readonly PiTimelineNode[];
  queue: readonly PiQueueItem[];
  phase: "idle" | "running" | "retrying" | "compacting" | "tree-navigation";
  activeTurnId?: string;
}
```

`headId` 必须是当前 Pi leaf 沿 parent chain 找到的最近可见 node ID；raw leaf 若是 label、model、thinking 或 hidden custom entry，不能直接作为 assistant-ui repository head。

## 10. Timeline event 协议

```ts
interface PiThreadEventEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  sequence: number;
  event: PiThreadEvent;
}

interface PiThreadEventBatch {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  fromSequence: number;
  toSequence: number;
  events: readonly PiThreadEventEnvelope[];
}

type PiThreadEvent =
  | { type: "phase-changed"; phase: PiThreadSnapshot["phase"]; activeTurnId?: string }
  | { type: "node-added"; node: PiTimelineNode }
  | { type: "node-rekeyed"; previousId: string; node: PiTimelineNode }
  | { type: "node-replaced"; node: PiTimelineNode }
  | { type: "part-added"; messageId: string; part: PiAssistantPart }
  | { type: "text-delta"; messageId: string; partId: string; delta: string }
  | { type: "reasoning-delta"; messageId: string; partId: string; delta: string }
  | { type: "tool-call-replaced"; messageId: string; part: PiToolCallPart }
  | { type: "message-finished"; message: PiAssistantMessage }
  | { type: "queue-replaced"; items: readonly PiQueueItem[] }
  | { type: "branch-replaced"; snapshot: PiThreadSnapshot };
```

规则：

- 普通 stream 只发 target delta/replacement。
- `message_end` 可以 canonicalize content，但不能在 tool 仍执行时提前 finish。
- `branch-replaced` 只用于成功的 Pi tree navigation 或无法增量表达的结构变化。
- `branch-replaced` 必须独占一个立即 flush 的 batch，内嵌 snapshot cursor 等于该 envelope sequence；后续 event 从 `cursor + 1` 继续。
- queue 更新不创建、删除或移动 timeline node。
- unknown node/part/tool reference 触发 reattach，不猜测 owner。
- batch 内 sequence 连续；重复 sequence 丢弃；gap 触发 single-flight resync。

## 11. PiThreadProjector

### 11.1 初始化

1. 读取 `session.sessionManager.getBranch()`；
2. 建立 entry ID 与 parent graph；
3. 计算 visible ancestor；
4. 投影 visible entry；
5. 折叠 toolResult 到 owner tool call；
6. 读取 Pi 两个 queue getter 并建立瞬态 queue mirror；
7. 建立 live message、tool owner、request 和 sequence 索引；
8. 订阅 `AgentSessionEvent`。

bootstrap 与 live 必须共享同一个 projector state 和 pure projection helpers。

### 11.2 Persistence checkpoint

`PiCompatibilityAdapter.synchronizePersistedBranch(reason)` 先用公开的 O(1) `sessionManager.getLeafId()` 比较 `lastSeenLeafId`；只有 leaf 变化时才读取 `getBranch()`，并与上次已知 entry ID 集合做增量同步。调用点：

- bootstrap 前；
- 每个 AgentSessionEvent 开始时做 O(1) leaf check，吸收前一个 event/extension handler 已追加的 entry；
- `message_end` 后安排一个串行 post-event checkpoint，等待 AgentSession 当前同步持久化片段完成；
- 每个 Desktop command resolve/reject 前；
- `compaction_end`、tree navigation 完成和 `entry_appended` 时。

checkpoint 必须保持 event 顺序：先发布当前 live canonical replacement，再发布对应 `node-rekeyed`。若当前版本的 message_end/persistence 顺序与 characterization 不一致，adapter 必须报兼容错误，不能无限等待或退回 timestamp identity。

Pi 的 non-trigger `sendCustomMessage()` 会先 append custom entry，再发 custom `message_start/end`。因此 message_start 必须先查询 checkpoint 中尚未绑定 event 的 canonical entry；匹配时直接更新该 canonical node，不能再创建 transient duplicate。

`custom_message` storage entry 不持有后续 event 的 `CustomMessage` 对象引用，这是 object-identity 规则的明确例外。projector 只能在“尚未绑定的 canonical custom entry”中按 `customType + JSON-safe content + JSON-safe details` 做结构化唯一匹配；零候选按 live message 处理，多个候选必须 projection fault/rebuild，禁止用时间窗口、最后一项或纯文本任选一个。

### 11.3 Event mapping

| Pi event | Projector 行为 |
| --- | --- |
| `agent_start` | phase -> running |
| `agent_end` | 不切 idle；记录 willRetry，等待 retry/queued continuation/agent_settled |
| `turn_start` | 分配 activeTurnId |
| user `message_start` | 新增正式 user node；关联最近一次 queue consumption/request |
| assistant `message_start` | 新增独立 running assistant node |
| custom `message_start/end` | 按 display 语义新增/finalize notice 或忽略 |
| persisted bash entry | 由 persistence checkpoint 新增 bash notice |
| assistant `message_update` | 按 assistantMessageEvent 更新 text/reasoning/tool-call part |
| toolcall start/args/end | upsert tool part，args end 后 waiting |
| `message_end` assistant | canonical content replacement；无 tool 时等待紧随其后的 `turn_end` finish |
| tool execution start/update/end | 更新 owner part execution/result |
| toolResult `message_end` | canonical fold 到 owner part，不建顶级 node |
| `turn_end` | 所有 tool terminal 后 finish assistant，清 activeTurnId |
| `queue_update` | reconcile transient queue；记录 removed occurrence 等待 consumption |
| `entry_appended` | 触发 persistence checkpoint；custom storage 本身不显示 |
| `auto_retry_start/end` | phase retrying/running；详情进 control |
| `compaction_start/end` | phase compacting/idle 或 running；checkpoint 后显示 summary notice |
| `session_info_changed` | 更新 control/catalog title |
| `thinking_level_changed` | 更新 control thinking level |
| `agent_settled` | phase idle，立即 flush |
| terminal assistant `stopReason=error/aborted` | 按 9.5 映射 incomplete；是否 idle 仍等待 `agent_settled` |
| Desktop command/projector error | 不伪造 Pi message；写 typed control error，projector fault 按 19.3 处理 |

### 11.4 Tool lifecycle

Pi 的 assistant `message_end` 发生在 tool execution 之前。为匹配 assistant-ui part status：

```text
assistant message_start       -> message running
toolCall args stream          -> part streaming-args
assistant message_end         -> canonical content, message remains running
tool_execution_start          -> part running
tool_execution_update         -> part running + partialResult
tool_execution_end            -> part complete/error
toolResult message_end        -> canonical result fold
turn_end                      -> 按 Pi stopReason 将该 assistant complete/incomplete
```

这样 assistant-ui 在 `result` 尚不存在时从 message running status 得到 running tool part；已有 terminal result 的 part 自动 complete。流式 `partialResult` 不得提前映射到 assistant-ui `result`，否则 assistant-ui 会把 part 误判为 complete。converter 将 `{ execution, partialResult }` 放入经过 JSON 安全转换的 UI-only `artifact`，`ToolView` 用它展示 waiting/running/progress；只有 `tool_execution_end` / canonical toolResult 才设置正式 `result`。`unstable_enableToolInvocations` 保持 `false`，renderer 永不执行 backend tool。

Tool execution error 是 tool part 的 `isError`，不等价于 assistant message incomplete。`ToolView` 必须优先读取 `isError` / artifact execution 显示错误，不能继续依赖旧 `tool-status-store` 或只检查 `MessagePartStatus.incomplete`。

owner 不存在、toolCallId 冲突或 result 无法关联时触发 projection fault/reattach，禁止挂到最后一条 assistant message。

### 11.5 Queue reconciliation

现有 Pi queue surface 是：

```ts
queue_update: { steering: readonly string[]; followUp: readonly string[] }
getSteeringMessages(): readonly string[]
getFollowUpMessages(): readonly string[]
clearQueue(): { steering: string[]; followUp: string[] }
```

Desktop reconciliation 规则：

1. 每个 mode 独立维护有序 occurrence registry。
2. Desktop submit 前登记 pending request，但不创建 queue item 或 timeline node。
3. `session.prompt()` 接受并产生 queue update 后，把新增 occurrence 与同一 main command scope 中的 pending request 关联。
4. Pi-origin/extension-origin 且能从 queue_update 观察到的新增 occurrence 分配 `pi-observed` ID。
5. update 删除 occurrence 时，将该 ID 放入短生命周期 `pendingConsumption` FIFO。
6. 随后的 user `message_start` 消费 FIFO，并把 queueId 写入 delivery metadata；idle prompt 则直接关联当前 accepted request。
7. 若文本经 extension/input/template 转换，以 Pi queue_update 中的最终文本为准。
8. `preflightResult(true)` 后既没有 queue_update 也没有 message_start，且 command 已 resolve，表示 extension command/input handler 已处理；清除 pending request，不创建消息。
9. reconciliation 异常只 resync queue mirror，不得破坏正式 timeline。

显式 `session.clearQueue()` 是 queue removal，不是 queue consumption。`PiCompatibilityAdapter` 必须在调用前后给 projector 建立同步 clear scope；该 scope 内的 `queue_update` 只替换 mirror，不得把被清空 item 放入 `pendingConsumption`。Desktop 不能通过等待下一个 user `message_start` 猜测 clear 是否完成。

`sendCustomMessage(...deliverAs)` 直接写入 Pi 内部 queue 时不会更新 `AgentSession` 的字符串 queue mirror。Desktop 无法在消费前观察此类 item，必须接受以下真实语义：

- pending queue UI 不提前展示不可观测 item；
- custom `message_start` 到达后按 display 规则进入 timeline；
- 不伪造提前可见的 queue item。

Desktop-origin queue registry 可以在进程内暂存原始 `AppendMessage` 和图片，用于 command 关联与显式 clear 后 reseed，但它不是 queue authority，不进入 snapshot/JSONL，也不能据此覆盖 Pi getter。Pi 字符串 queue 对 image-only 或空文本项的消费可观测性必须由 characterization test 锁定；若当前 public surface 无法可靠反映消费，Desktop 必须暴露限制或禁用该发送形态，不能擅自从 mirror 删除 item。

### 11.6 不支持的 queue 操作

Pi 公共 API 不提供单项 remove 或 follow-up -> steer promote。因此 Desktop：

- 不渲染 `QueueItemPrimitive.Remove`；
- 不渲染 `QueueItemPrimitive.Steer`；
- 不暴露单项 IPC；
- 不使用 `clearQueue()` + re-enqueue 模拟单项操作；
- 不按文本删除；
- 仅支持 Pi 原生整体 clear。

`ExternalThreadQueueAdapter` 类型要求存在 `steer/remove` callback。集中 adapter 中这两个 callback 必须调用 `unsupportedQueueOperation()` 并抛出明确错误；正常 UI 不提供触发入口。禁止空 callback。

## 12. Command adapter

### 12.1 Pi-native input

```ts
interface SessionPromptInput {
  requestId: string;
  projectId: string;
  threadId: string;
  text: string;
  images: ImageInput[];
  desiredMode?: "steer" | "followUp";
}
```

renderer 不发送历史、tools、state、provider request 或 runId。

### 12.2 所有用户输入统一走 `session.prompt()`

Desktop 不直接调用 `session.steer()` / `session.followUp()` 处理 Composer 输入。main 根据权威 Pi 状态调用：

```ts
await session.prompt(input.text, {
  images: toPiImages(input.images),
  ...(session.isStreaming
    ? { streamingBehavior: input.desiredMode ?? "followUp" }
    : {}),
  source: "interactive",
  preflightResult: onPreflight,
});
```

原因：`prompt()` 才完整保留以下 Pi 语义：

- extension command 在 running 时也可以立即执行；
- extension input handler 可以 handle/transform；
- skill/template expansion；
- model/auth/pre-compaction checks；
- streamingBehavior 的真实 steer/follow-up 分流。

Desktop 不预判 slash command，也不复制 expansion 逻辑。

### 12.3 External queue adapter 的 idle/running 分派

assistant-ui 0.14.26 在配置 `queue` 后，所有非 edit append 都调用 `queue.enqueue`，idle 时也不会调用 `onNew`。因此：

```ts
const queue: ExternalThreadQueueAdapter = {
  items: snapshot.queue.map(({ id, prompt }) => ({ id, prompt })),
  enqueue(message, { steer }) {
    commandCoordinator.submit(message, {
      desiredMode: steer ? "steer" : "followUp",
      phase: store.getState().phase,
    });
  },
  steer: unsupportedQueueOperation,
  remove: unsupportedQueueOperation,
  clear: (reason) => commandCoordinator.observeFrameworkClear(reason),
};
```

`commandCoordinator.submit()` 必须在执行时重新读取 phase：

- idle：调用 `sessions.prompt`，main 不传 streamingBehavior；
- running：调用同一 `sessions.prompt`，main 传 desiredMode；
- retrying/compacting/tree-navigation：发送 disabled，不接受 submit。

renderer phase 只用于交互路由；main 以调用瞬间的 `session.isStreaming` 为最终权威，处理跨 IPC 竞态。

Projector 的 pending prompt 必须分别记录 timeline identity eligibility 与 queue eligibility。idle prompt 需要保留 requestId 以关联随后正式消费的 user message，但不能参与后续 queue item 的 requestId 匹配；否则第一个 running follow-up 会错误绑定到旧 idle `AppendMessage`，clear 时恢复错误文本或附件。`queueEligible` 必须和实际传给 Pi 的 `streamingBehavior` 共用同一次 `session.isStreaming` 快照，不能仅根据 `desiredMode` 判断，因为 assistant-ui queue adapter 在 idle submit 时也会传 desiredMode。

### 12.4 Queue callback 的异步错误

`ExternalThreadQueueAdapter` callback 返回 `void`，assistant-ui 不等待其 Promise。因此 coordinator 必须：

- 捕获 AppendMessage 和 complete attachments；
- 自己维护 command single-flight；
- `void execute().catch(handleCommandError)`，禁止 unhandled rejection；
- 失败时恢复 Composer text/attachments；
- `preflightResult(false)` 才表示输入未被 Pi 接受并允许 reseed；
- `preflightResult(true)` 后发生的 run/tool/provider error 属于真实 timeline error，不能再次提交同一输入；
- 只对匹配 requestId、thread 和 generation 的失败 reseed；
- 把 typed error 写入 control/UI；
- 不回滚 timeline，因为权威 `message_start` 前没有 optimistic node。

### 12.5 Clear/cancel/edit/reload 协调

assistant-ui 会在 cancel/edit/reload 前同步调用 `queue.clear(reason)`。该 callback 不能独立启动一个与随后 command 竞态的 IPC。

`observeFrameworkClear(reason)` 只记录 assistant-ui 发出的 advisory intent 和诊断，不修改 Pi queue。真正的 `onCancel/onEdit/onReload` command 根据 Pi 语义独立决定操作；不能依赖 microtask 关联，因为 assistant-ui 的 reload 路径会在 clear 与 `onReload` 之间执行异步步骤。

手动“清空全部队列”使用独立 Desktop command `sessions.clearQueue()`，返回 Pi 原生 `{steering, followUp}` 并按当前产品规则 reseed Composer。Desktop-origin item 可从瞬态 registry 恢复完整 text/image input；仅由 Pi 字符串 surface 观察到的 item 只能恢复 text，不可观测 extension queue item 无法恢复。UI 不得声称所有来源都能完整恢复。

由于 Pi 当前 `clearQueue()` 会同步发出 `queue_update`，clear scope 只能包住这次同步 public call；升级 Pi 后必须由 characterization test 继续锁定该顺序。如果上游改为异步 queue update，Desktop 适配层必须随 public contract 调整，不能用计时器或文本匹配维持旧假设。

### 12.6 Cancel

按 projector phase 映射：

| phase | Pi operation |
| --- | --- |
| running/retrying | `session.abort()` |
| compacting | `session.abortCompaction()` |
| tree-navigation | `session.abortBranchSummary()` |
| idle | 不暴露 cancel capability |

是否清 queue 只由显式 Desktop clear command 决定；`session.abort()` 本身不清 queue，Desktop 不得因 assistant-ui 默认行为改变 Pi 语义。

## 13. Branch、Edit 与 Reload

### 13.1 权威语义

Pi JSONL 是 append-only tree。Edit/reload 必须使用现有 `AgentSession.navigateTree()`，不得删除或改写旧 entry。

### 13.2 Edit user message

1. 从 assistant-ui `AppendMessage.sourceId` 读取被编辑的 message ID；`parentId` 只是该消息的父节点，不能当作编辑目标；
2. 用 repository/message metadata 把 sourceId 映射为 `sourceEntryId`，并验证目标是当前 Pi tree 中的 user entry；
3. 调用 `session.navigateTree(userEntryId, { summarize: false })`；
4. Pi 将 leaf 移到该 user entry 的 parent，并返回 editorText；
5. 使用编辑后的 Composer input 调用正常 `session.prompt()`；
6. 新 user/assistant entry 形成 append-only branch；
7. projector 从 `getBranch()` 重建并发布 `branch-replaced`。

Desktop 必须验证 user target navigation 返回了 `editorText`。Pi public `navigateTree()` 对“target 已是当前 leaf”会 no-op；此时 Desktop 必须拒绝 edit/reload，不能继续 prompt 形成错误的 user -> user branch，也不能调用 `SessionManager.branch/resetLeaf` 私有重现该行为。

### 13.3 Reload assistant message

1. 接收 assistant-ui `onReload(parentId, config)` 提供的可见 parentId；
2. renderer 在当前 repository parent 链上向上解析最近的持久化 user node，并把其 `sourceEntryId` 作为 typed reload target；notice 可能位于 user 与 assistant 之间，不能假设 callback parentId 本身就是 user entry；
3. main 再次验证 target 指向当前 Pi tree 中的 user entry，并读取原始 text/image content；
4. 调用 `session.navigateTree(userEntryId, { summarize: false })`；
5. 使用 `session.sendUserMessage(originalContent)` 或等价的 `prompt(...expandPromptTemplates:false)` 重新提交已展开内容；
6. 不重新执行原始 slash command/template expansion；
7. 新响应形成 branch；
8. projector 发布 `branch-replaced` 后继续 live events。

若无法确定前置 user entry、目标属于不可重放 custom flow，或 navigateTree 被 extension 取消，reload 失败并保留当前 branch。

`sendUserMessage()` 仍会按 Pi 原生语义再次触发 input hook，且 source 为 `extension`。因此 reload 是“从原 user entry 导航后做一次 Pi-native 新提交”，不是字节级确定性重放；Desktop 不得绕过 input hook，也不得承诺扩展 transform/handle 后得到与原 turn 相同的内容。

Edit/reload command 在 navigate 前记录 old leaf。若 navigate 成功但后续 prompt 预检失败，Desktop 使用 `navigateTree(oldLeaf, { summarize: false })` 尝试恢复原 branch，并 reseed Composer。恢复也被 extension 取消或失败时，以 Pi 当前 leaf 为权威发布 `branch-replaced` 和 typed error，禁止用 renderer snapshot 假装回滚成功。

### 13.4 assistant-ui repository

runtime 使用 `messageRepository`，不使用 `messages + convertMessage`：

```ts
const repository = {
  headId: converted.headId,
  messages: converted.nodes.map(({ message, parentId }) => ({ message, parentId })),
};
```

原因：`messages + convertMessage` 会按数组前一项重建 parent，忽略 Pi parent identity。repository converter 必须 memoize unchanged source node，delta 只重建目标 message。

每次 store revision 变化必须创建新的 `messageRepository` wrapper；只允许复用 wrapper 内未变化的 `ThreadMessage`。assistant-ui 0.14.26 在 `isRunning` 未变且 wrapper 引用相同时会跳过 repository sync，因此不能原地修改 wrapper、`messages` 数组或其中 item。

不提供 `setMessages`，避免 assistant-ui BranchPicker 做 renderer-only branch switch。需要完整 session tree UI 时，应新增调用 `sessions.navigateTree` 的 Pi-native view。

## 14. Notice 与 extension 适配

### 14.1 Notice converter

`PiNoticeMessage` 转为 assistant-ui assistant message，但必须带明确 transport metadata：

```ts
{
  role: "assistant",
  content: [{ type: "data", name: "pi-notice", data: noticePayload }],
  status: { type: "complete", reason: "unknown" },
  metadata: { custom: { pi: { kind: "notice", noticeType, sourceEntryId } } },
}
```

`PiNoticeView` 根据 noticeType 渲染 bash、custom、compaction 和 branch summary。它不是模型 assistant 文本，不参与 copy/reload 等消息操作。

### 14.2 Extension 规则

- `custom display=false` 永不显示；
- `custom display=true` 把 string 或 text/image content 规范化为 `PiUserContentPart[]`，并保留 customType/details 的安全投影；
- details 不可序列化时显式降级；
- extension HostUi 继续走 control/HostUi channel，不塞进 timeline；
- extension raw event、credentials、provider request 不进入 renderer；
- extension command 的执行结果完全由 Pi events 决定。

## 15. Renderer store 与 converter

### 15.1 PiThreadStore

使用独立 vanilla store 或最小 `useSyncExternalStore`：

- store 实例跨 thread 稳定；
- snapshot/branch replace 单次原子更新；
- delta 不触发 Desktop/sidebar reducer；
- 未修改 node/part 保持引用 identity；
- reducer 为纯函数；
- store 不访问 `window.desktop`。

### 15.2 Repository converter

集中 pure converter：

```ts
function toAssistantThreadMessage(node: PiTimelineNode): ThreadMessage;
function buildAssistantMessageRepository(snapshot: PiThreadSnapshot): ExportedMessageRepository;
```

映射要求：

- source node identity 不变时复用 `ThreadMessage`；
- user text + images -> text content + complete attachments；
- assistant text/reasoning/tool -> 对应 parts；
- notice -> `data:pi-notice`；
- delivery/request/sourceEntryId -> `metadata.custom.pi`；
- error -> `{ type: "incomplete", reason: "error", error: JsonValue }`；
- tool `execution/partialResult` 映射到 UI-only artifact，terminal result 才映射到 `result`；
- assistant-ui part status 只由合法 message status 与 terminal result 推导；
- ToolView 用 `isError` 表达 tool failure，不把 tool error 提升为 assistant message error；
- 不把 backend tool 注册为 frontend executable tool。

### 15.3 Runtime adapter

```tsx
const phase = store.phase;
const isAgentRunning = phase === "running" || phase === "retrying";
const canMutateBranch = phase === "idle" && readiness.state === "ready";

const runtime = useExternalStoreRuntime({
  messageRepository: assistantRepository,
  isRunning: isAgentRunning,
  isLoading: phase === "compacting" || phase === "tree-navigation",
  isSendDisabled:
    readiness.state !== "ready" ||
    phase === "retrying" ||
    phase === "compacting" ||
    phase === "tree-navigation",
  onNew: commandCoordinator.rejectUnexpectedOnNew,
  queue,
  onEdit: canMutateBranch ? commandCoordinator.edit : undefined,
  onReload: canMutateBranch ? commandCoordinator.reload : undefined,
  onCancel: phase === "idle" ? undefined : commandCoordinator.cancel,
  adapters: {
    attachments: readiness.state === "ready" ? imageAttachmentAdapter : undefined,
    threadList,
  },
  unstable_enableToolInvocations: false,
});
```

配置 queue 后正常 non-edit submit 必须经 `queue.enqueue`。`rejectUnexpectedOnNew` 返回 rejected Promise，并报告 assistant-ui queue routing 已不兼容；它不能静默改走另一条 submit 路径。测试必须锁定该版本行为。

queue adapter 必须始终存在；发送禁用依赖 `isSendDisabled`，不能通过临时移除 queue 改变 idle submit 路由。assistant-ui 的 edit composer 不受 `isSendDisabled` 限制，所以非 idle/readiness 不满足时必须直接省略 `onEdit/onReload`，不能只禁用 Send。

assistant-ui 0.14.26 在 `isRunning=true` 且 repository 尾部不是 assistant 时，会在其内部 repository 增加 `metadata.isOptimistic=true` 的空 assistant placeholder。该节点是第三方 runtime 的瞬态 UI facade：不得进入 `PiThreadStore`、IPC、exported `messageRepository` 或 Pi command，不得获得 Pi metadata/action；真实 Pi assistant 到达或 run settle 后必须消失。characterization test 必须锁定这一行为，组件不得把它误显示为持久化 Pi message。compaction/tree navigation 不设置 `isRunning`，避免为非 agent 操作生成 placeholder。

### 15.4 Capability matrix

| assistant-ui capability | 条件 |
| --- | --- |
| copy | 普通 user/assistant message；notice 可单独定义 copy |
| cancel | 当前 phase 有对应 Pi abort API |
| attachments | image adapter 可用且 readiness ready |
| edit | idle、目标是可导航 user entry、typed edit 已实现 |
| reload | idle、可解析原始 user turn、typed reload 已实现 |
| queue | ExternalThreadQueueAdapter 已接入 |
| queue steer/remove item | 不渲染，Pi 不支持 |
| speech/dictation/voice/feedback | 对应 adapter 存在时才启用 |
| frontend tool invocation | 永远关闭 |
| branch picker | 关闭；使用 Pi-native tree navigation |

## 16. Thread list 与 draft

### 16.1 External Store Thread List

使用 `ExternalStoreThreadListAdapter`：

- 每个 thread data 的本地 `id` 为 `${projectId}:${threadId}`，adapter 本身没有 ID 字段；
- remoteId 为 Pi thread ID；
- controlled New/Trigger/Rename/Archive/Unarchive/Delete；
- Project grouping 和确认交互保持；
- `ThreadListPrimitive.New` 由 Desktop 阻止默认 action，只进入 renderer draft；draft materialize 时才显式调用 `runtime.threads.switchToNewThread()`，从而进入 `onSwitchToNewThread` 的 create + attach；
- adapter 所有使用集中在 `usePiExternalRuntime`。

### 16.2 Thread switch

1. controller 分配 generation；
2. preload 安装 pending listener；
3. `sessions.attach()` 返回 snapshot/control/attachmentId；
4. generation 仍有效时在同一 React batch 提交 `PiThreadStore.replace` 与 Desktop active selection/control/workbench；
5. repository/threadList adapter props 同步更新；
6. listener 建立后 flush buffered push；
7. stale attachment 只 detach 自己 token。

切换不 abort Pi，不 replay、不 join、不 `startRun()`。

### 16.3 Draft materialize

```text
draft submit
  -> capture AppendMessage + complete attachments
  -> sessions.create(explicit model/thinking)
  -> atomic attach returns empty Pi snapshot
  -> store.replace + committed Desktop state
  -> commandCoordinator.submit
  -> session.prompt
  -> Pi events create first user/assistant nodes
```

create/attach 前失败删除新 session 并保留 draft；prompt 已接受后失败属于真实 session error，不删除历史。

## 17. Bootstrap、attach 与 resync

```ts
interface PiSessionBootstrap {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  timeline: PiThreadSnapshot;
  control: SessionControlState;
}

type SessionPushPayload =
  | { type: "control"; projectId: string; threadId: string; control: SessionControlState }
  | { type: "timeline"; projectId: string; threadId: string; batch: PiThreadEventBatch };
```

删除 AG-UI messages/state、activeRun replay 和独立 tool push。

### 17.1 原子 attach

`SessionSupervisor.attach()`：

1. `await requireRuntime(projectId, threadId)`；
2. 同步读取 projector snapshot；
3. 不经过新 await，同步替换 owner attachment；
4. 返回 `{ attachmentId, bootstrap }`。

snapshot cursor 覆盖 `sequence <= cursor` 的全部 projector state。

### 17.2 Resync

sequence gap、协议错误、unknown reference 或 reducer invariant 失败时：

1. store 停止应用当前 attachment；
2. bus single-flight reattach；
3. 原子 replace timeline/control；
4. flush 新 attachment buffer；
5. token 丢弃旧 push。

不调用 `thread.import()`，不 replay event log。

## 18. Control plane

`SessionControlState` 表达：

- title/cwd；
- model/models；
- thinking level/levels；
- readiness；
- context usage；
- retry/compaction/tree-navigation details；
- queue mode `all | one-at-a-time`；
- HostUi requests；
- extension UI/commands；
- last typed error。

### 18.1 Extension composer command

Extension editor 能力以 [`desktop-controlled-extensions-spec.md`](./desktop-controlled-extensions-spec.md) 为准。Desktop 只支持 extension 到 renderer 的单向 Composer command：

- `setEditorText()` 产生 revisioned `replace` command；
- `pasteToEditor()` 产生 revisioned `append` command；
- renderer 按 project/thread target 和 revision 至多应用一次；
- 用户逐键输入不回传 sidecar；
- `getEditorText()` 在 Desktop Host Profile v1 明确不可用；
- command 不写入 timeline 或 `session.jsonl`。

以下不再作为 control authority：

- running flag；
- queue string arrays；
- tool execution store；
- message history。

Thread catalog 中用于 sidebar 的 `running` 只读标记由每个 SessionRuntime 的 projector phase 派生，可以保留在 thread summary；active assistant-ui `isRunning` 只能读取 `PiThreadStore.phase`，不能反向依赖 catalog/control。

## 19. 并发与错误

### 19.1 Command idempotency

- requestId 在 renderer coordinator 创建；
- main 对同 requestId single-flight；
- 完成记录保留有界 TTL，IPC retry 不重复 prompt；
- command resolve 只表示 Pi 公共方法 settle；
- timeline 只由 Pi events 更新；
- command failure 不产生 phantom node。

### 19.2 快速切换

- generation 只在 controller/runtime adapter 边界维护；
- stale bootstrap 不 replace store；
- stale command error 不 reseed 新 thread；
- active selection、timeline、control、Workbench 属于同一 generation；
- thread switch 不 abort background Pi run。

### 19.3 Fatal projector error

1. 记录脱敏结构化诊断；
2. 停止发布当前不完整 batch；
3. 发布 projection-error control；
4. 从 `getBranch()` + 当前 live overlay 共用 helpers 重建 snapshot；
5. 重建失败则停止该 runtime timeline publish，attach 返回 typed error；
6. 不静默丢 event，不发送半合法 patch。

## 20. 性能要求

1. text/reasoning delta payload 与历史长度无关。
2. delta apply 只复制目标 node/part。
3. repository converter 复用 unchanged ThreadMessage。
4. 每个 store revision 生成新 repository wrapper，但不重建未变化 message。
5. Sidebar/Desktop reducer 不订阅 delta。
6. main 可以在每个 event 做 O(1) leaf check，但不得在每个 delta 遍历 `getBranch()`。
7. full snapshot 仅用于 attach/resync/Pi tree navigation。
8. 1,000 nodes + 1,000 deltas 不得产生 1,000 次全历史转换。
9. queue reconciliation 与 queue 长度相关，并设置诊断阈值。
10. 大型 tool/bash/custom result 使用统一截断策略。

## 21. 安全要求

- redacted/encrypted reasoning 不进入 timeline。
- tool args/result/details 使用 `JsonValue` 安全转换。
- 循环引用、BigInt、function 等显式降级。
- full output path 仅在允许公开时进入 renderer。
- attachment data 只传输一次。
- HostUi raw payload、provider request/response、credentials 不进入 timeline。
- renderer 不执行 Pi backend tool。
- 不从错误诊断输出未脱敏 prompt/reasoning/tool secret。

## 22. 预计文件变更

### 22.1 新增

```text
packages/desktop/src/main/pi/pi-compatibility-adapter.ts
packages/desktop/src/main/pi/pi-thread-projector.ts
packages/desktop/src/renderer/src/runtime/pi-thread-store.ts
packages/desktop/src/renderer/src/runtime/pi-session-bus.ts
packages/desktop/src/renderer/src/runtime/pi-message-repository.ts
packages/desktop/src/renderer/src/runtime/pi-command-coordinator.ts
packages/desktop/src/renderer/src/runtime/use-pi-thread-snapshot.ts
packages/desktop/src/renderer/src/components/chat/pi-notice-view.tsx
```

### 22.2 重写

```text
packages/desktop/src/main/pi/session-runtime.ts
packages/desktop/src/main/pi/session-supervisor.ts
packages/desktop/src/shared/contracts.ts
packages/desktop/src/shared/desktop-api.ts
packages/desktop/src/preload/index.ts
packages/desktop/src/renderer/src/runtime/use-pi-runtime.ts
packages/desktop/src/renderer/src/state/desktop-context.tsx
packages/desktop/src/renderer/src/state/use-desktop-controller.ts
packages/desktop/src/renderer/src/components/chat/composer.tsx
packages/desktop/src/renderer/src/components/chat/tool-view.tsx
```

### 22.3 删除

迁移完成后删除：

```text
packages/desktop/src/main/pi/pi-ag-ui-adapter.ts
packages/desktop/src/main/pi/message-projector.ts
packages/desktop/src/renderer/src/runtime/electron-pi-agent.ts
packages/desktop/src/renderer/src/runtime/ag-ui-messages.ts
packages/desktop/src/renderer/src/runtime/session-event-bus.ts
packages/desktop/src/renderer/src/runtime/tool-status-store.ts
```

禁止修改：

```text
packages/ai/**
packages/agent/**
packages/coding-agent/**
```

### 22.4 依赖

确认 Desktop 无其他使用者后删除：

```json
{
  "@ag-ui/client": "...",
  "@ag-ui/core": "...",
  "@assistant-ui/react-ag-ui": "...",
  "rxjs": "..."
}
```

保留并精确锁定当前验证版本：

```json
{
  "@assistant-ui/react": "0.14.26",
  "@earendil-works/pi-coding-agent": "0.80.7"
}
```

升级任一依赖都必须先运行 compatibility characterization tests。

## 23. 原子迁移计划

### 阶段一：characterization 与协议

- 锁定当前 Pi prompt/queue/event/tool/tree/compaction 行为；
- 锁定 assistant-ui queue idle routing、clear-before-command 和 repository 行为；
- 定义新 protocol；
- 不接生产 publish。

### 阶段二：projector 与 store

- 实现 compatibility adapter；
- 实现 branch/bootstrap/live/tool/notice/queue projector；
- 实现 renderer store 和 repository converter；
- 完成 pure reducer 与性能测试。

### 阶段三：runtime adapter

- 实现 command coordinator；
- 接入 repository、queue、attachments、thread list、capabilities；
- 实现 Pi-native edit/reload/cancel；
- 使用 faux provider/IPC 做 focused tests。

### 阶段四：原子切换

同一个迁移提交中：

- main publish 切到 Pi timeline；
- bootstrap/attach 切到新 protocol；
- renderer provider 切到 External Store；
- prompt/queue/cancel/edit/reload 切到 typed Pi-native commands；
- 删除 active run join/replay；
- 禁止旧新协议双写。

### 阶段五：清理

- 删除 AG-UI adapter/agent/converters/tool store；
- 删除依赖；
- 更新旧规范状态；
- 检查 dead channels、preload types、runtime capabilities；
- 完成产品与性能回归。

## 24. 测试要求

### 24.1 Pi compatibility characterization

在 Desktop 测试中使用 Pi 公共 API 和 faux provider，不修改 Pi 测试或源码，覆盖：

- idle `prompt()` event/persistence 顺序；
- 普通 message persistence 不产生 `entry_appended`，post-event checkpoint 能观察到 entry；
- running `prompt(...streamingBehavior)`；
- extension command running 时不进入 queue；
- input hook handle/transform；
- steer/follow-up `all` 与 `one-at-a-time`；
- duplicate text queue_update；
- 显式 clear 的 queue removal 不会关联到下一条 user message；
- queue_update 在 consumed user message_start 前发生；
- `sendCustomMessage` display true/false 与 deliverAs；
- non-trigger custom entry 先持久化、后 message_start 时不重复 node；
- assistant message_end 先于 tool execution；
- parallel tool completion order；
- compaction entry 与 buildContext/getBranch 差异；
- navigateTree user target 的 editorText/leaf 语义；
- abort 不隐式 clear queue；
- reload public method 只重载资源，不等价于 assistant response reload。

### 24.2 Projector

- persisted entry ID/parent 和 nearest visible ancestor；
- user/assistant/bash/custom/compaction/branch summary；
- hidden custom 不显示；
- live transient -> entry ID rekey；
- persistence checkpoint 不依赖普通 message 的 `entry_appended`；
- redacted reasoning；
- tool canonicalization、partial、success/error、parallel；
- partialResult 只进入 artifact，terminal result 才完成 tool part；
- tool `isError` 在 assistant message complete 时仍显示错误；
- assistant 到 turn_end 才 finished；
- queue occurrence reconciliation；
- duplicate text；
- unobservable custom queue；
- snapshot 与全部 event 后 state 等价；
- fatal rebuild 使用同一 helpers。

### 24.3 Store/repository

- snapshot/branch replace；
- duplicate/gap/unknown reference；
- target-only structural sharing；
- rekey 更新 parent/head/tool indexes；
- notice converter；
- image 只生成一份 complete attachment；
- assistant-ui status 合法；
- Pi `stop/toolUse/length/aborted/error` 映射穷尽且不解析错误文本；
- repository parent 使用 Pi visible ancestor；
- repository wrapper revision 更新，unchanged message identity 保持；
- assistant-ui optimistic placeholder 不进入 exported repository/Pi store；
- 1,000 nodes + 1,000 deltas identity/performance。

### 24.4 Runtime/coordinator

- 配置 queue 后 idle send 仍调用 Pi prompt；
- running send 传正确 desiredMode；
- main phase race 由 `session.isStreaming` 收口；
- idle pending prompt 不抢占后续 streaming queue request identity；
- queue callback rejection 被捕获并 reseed；
- stale request 不 reseed 新 thread；
- steer/remove control 不渲染，直接调用 fail fast；
- clear-before-cancel/edit/reload 不产生双 IPC；
- cancel 按 phase 映射；
- edit/reload 使用 navigateTree，不做 renderer-only history；
- edit 使用 `sourceId`、reload 使用 `parentId` 定位 Pi entry；
- reload 再次经过 Pi input hook，且不承诺字节级确定性重放；
- `isSendDisabled` 时 edit/reload callback 被移除；
- backend tool 不执行；
- capability 与公共 Pi API 一致。
- extension composer command 按 target/revision 单次应用；
- queue clear 恢复文本不会被旧 extension composer command 覆盖；

### 24.5 Attach/thread/draft

- bootstrap cursor 与 attachment 注册无缺口；
- invoke resolve 前 push 被 buffer；
- stale attach/detach/generation；
- running attach 第一帧含 partial assistant/tool/queue；
- switch 不 abort；
- draft 首次提交只 create/attach/prompt 一次；
- New button 不调用 runtime `switchToNewThread`，仅首次 submit materialize 时调用；
- readiness/create/attach/prompt failure reseed 边界；
- Workbench/HostUi/extension UI 不回归。

### 24.6 产品顺序回归

必须覆盖活动态与 settle 后：

```text
assistant A
pending queue: B, D
Pi consumes B
assistant C
Pi consumes D
assistant E
```

Timeline 必须依次成为 `A -> B -> C -> D -> E`；B/D 在未消费前只显示在 queue surface。

还需覆盖：

- 多 steer；
- 多 follow-up；
- steer + follow-up；
- duplicate text；
- tool loop 中 queue；
- retry/compaction 时发送禁用；
- extension command/custom message；
- cancel 后 Pi 原生 queue 语义；
- edit/reload branch；
- fast thread switching；
- image reload 后确定性 attachment。

### 24.7 验收命令

新增/修改测试逐个运行：

```sh
cd packages/desktop
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

最后在仓库根运行：

```sh
npm run check
```

不运行 `npm test` 或 build，除非用户明确要求。

## 25. 验收标准

1. 没有修改 `packages/ai`、`packages/agent`、`packages/coding-agent` 或 session JSONL 语义。
2. Desktop 不再依赖 `@assistant-ui/react-ag-ui` 或传输 AG-UI `BaseEvent`。
3. Pi active branch 的所有可见 entry 类型按本规范映射。
4. 每条 user/assistant message 保持独立 identity。
5. pending queue 不提前污染 timeline，multiple one-at-a-time 顺序正确。
6. extension command/input hook/template/skill expansion 仍由 `session.prompt()` 处理。
7. 不支持的 queue remove/promote 不显示且 fail fast。
8. tool 在真实执行期间显示 running，turn_end 后才终结 assistant。
9. persisted identity 使用现有 SessionEntry ID/parent。
10. edit/reload 使用 navigateTree append-only branch，不改写历史。
11. bootstrap/reattach 直接提供完整 snapshot，无 active replay。
12. resync 原子替换 store，不重建 runtime。
13. tool lifecycle 只存在于 message part，不存在 renderer tool status store。
14. `messageRepository` 保留 Pi parent/head；不提供 renderer-only `setMessages`。
15. runtime capability 与 Pi 公共 API 严格一致。
16. draft、attachments、cancel、受控 Extension Host、单向 composer command、model/thinking、Workbench 和 thread CRUD 通过回归。
17. 不存在 AG-UI/timeline、vOld/vNew 或 projector/component 双写。
18. compatibility、focused、performance tests 与根级 `npm run check` 全部通过。
19. linked 旧规范没有留下任何要求修改 Pi public API/source/JSONL 的实施前置条件。
20. assistant-ui 内部 optimistic placeholder、dynamic capability 和 repository wrapper identity 均有 characterization test。

## 26. 风险与决策门槛

### 26.1 上游 queue 可观测性

字符串 queue surface 无法提供全局稳定 item identity、图片恢复、单项 remove/promote 或所有 extension-origin queue 预览。本规范通过“不提前写 timeline、只提供真实能力”保证正确性。若产品强制要求这些能力，只能等待 Pi 公共 API 自身增加支持；Desktop 不得绕过本约束。

### 26.2 assistant-ui unstable API

External Store Thread List 和 queue API 仍在 active development：

- 精确锁定版本；
- 集中封装；
- characterization tests 锁定 queue idle routing、clear-before-command、repository parent；
- 升级时先修 adapter，不修改 Pi。

### 26.3 Projector 复杂度

projector 承担多种 Pi entry/event 到 UI timeline 的适配，但不得处理 IPC、React 或命令。branch projection、live overlay、tool folding、queue reconciliation 必须拆成 pure helpers，并分别测试。

### 26.4 Reload 术语冲突

Pi `AgentSession.reload()` 是资源/extension reload，不是重新生成 assistant response。assistant-ui `onReload` 必须映射到 navigateTree + resend，禁止误调用 Pi `reload()`。

### 26.5 assistant-ui facade 差异

assistant-ui 的 optimistic placeholder、callback-presence capability 和 queue routing 是 UI runtime 行为，不是 Pi 语义。Desktop 只能在集中 adapter 中隔离这些差异，并用版本锁定测试防止其泄漏到 Pi timeline、commands 或 persistence。若升级后无法继续隔离，升级必须阻断，不能修改 Pi 迎合新行为。

## 27. 实施验证清单

- [x] 用户确认 Pi 与 JSONL 全部只读；
- [x] Pi public surface characterization tests 已通过；
- [x] assistant-ui 0.14.26 queue/repository characterization tests 已通过；
- [x] bash/custom/compaction/branch-summary notice UI 已实现；
- [x] queue 仅支持 Pi 原生整体 clear，单项 remove/promote 不渲染并 fail fast；
- [x] pending queue 不提前进入 timeline；
- [x] edit/reload 使用 `navigateTree()` 形成 append-only branch；
- [x] Extension Host 只向 Composer 发送 revisioned replace/append command，用户输入不回传 sidecar；
- [x] protocol、Desktop 依赖与 lockfile 已原子迁移；
- [x] 1,000 nodes + 1,000 deltas identity/performance 回归已实现。

## 28. 参考

- [assistant-ui External Store Runtime](../../../.agents/skills/runtime/references/external-store.md)
- [`ExternalStoreAdapter`](../../../node_modules/@assistant-ui/core/src/runtimes/external-store/external-store-adapter.ts)
- [`ExternalStoreThreadRuntimeCore`](../../../node_modules/@assistant-ui/core/src/runtimes/external-store/external-store-thread-runtime-core.ts)
- [`ExternalThreadQueueAdapter`](../../../node_modules/@assistant-ui/core/src/runtime/queue/external-thread-queue-adapter.ts)
- [Desktop ThreadList Primitives 规范](./assistant-ui-thread-list-primitives-spec.md)
- [Desktop 新会话草稿规范](./new-session-draft-spec.md)
- [`AgentSession`](../../coding-agent/src/core/agent-session.ts)
- [`SessionManager`](../../coding-agent/src/core/session-manager.ts)
- [`AgentMessage` custom types](../../coding-agent/src/core/messages.ts)
