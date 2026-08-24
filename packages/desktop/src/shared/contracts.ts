import type { AgentSessionEvent, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

export interface RpcExtensionHostState {
  statuses: Record<string, string>;
  windowTitle?: string;
  composerCommand?: {
    hostId: string;
    revision: number;
    mode: "replace" | "append";
    text: string;
  };
  widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  working?: {
    message?: string;
    visible?: boolean;
  };
}

/** Desktop 与 renderer 之间使用的协议版本。 */
export const PROTOCOL_VERSION = 10;

/** Desktop 内部通用对话工作区的稳定 ID。 */
export const GENERAL_WORKSPACE_ID = "__general__";

/** 判断 Project 是否为内部通用工作区。 */
export function isGeneralProject(idOrProject: string | { id: string; kind?: string }): boolean {
  const id = typeof idOrProject === "string" ? idOrProject : idOrProject.id;
  return id === GENERAL_WORKSPACE_ID;
}

/** 判断 Project 是否为真实用户项目（非通用工作区）。 */
export function isUserProject(idOrProject: string | { id: string; kind?: string }): boolean {
  return !isGeneralProject(idOrProject);
}

/** 可以安全通过 Electron IPC 传输的 JSON 值。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 本地工作区项目。kind 为 "general" 表示 Desktop 管理的通用对话工作区。 */
export interface Project {
  id: string;
  kind?: "project" | "general";
  name: string;
  cwd: string;
  lastOpenedAt: number;
  available: boolean;
  issue?: string;
}

/** Project 所属 Git 仓库中的一个 worktree；path 保留 Project 在仓库内的相对位置。 */
export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string;
  current: boolean;
}

/** Pi 会话在线程列表中的摘要。 */
export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  /** 最后一对消息中用户消息的文本（前两行），用于侧边栏 hover 预览。 */
  lastUserPreview?: string;
  /** 最后一条 AI 回复的文本（前两行）；空或缺失表示最后一条消息无 AI 回复，不展示预览。 */
  lastAssistantPreview?: string;
  archived: boolean;
  running: boolean;
  /** 渲染器本地标记：运行完成（成功或失败）后尚未被用户查看。主进程从不发送该字段。 */
  completed?: boolean;
  parentThreadId?: string;
  origin?: "branch" | "subagent";
  /** Configured agent identity for subagent sessions; independent from the user-editable title. */
  agentName?: string;
}

/** Thread 加 session.jsonl 绝对路径，用于 @ 提及会话引用。 */
export interface SessionMentionCandidate extends Thread {
  path: string;
}

/** 侧边栏 hover 预览中用户消息预览的最大字符数。 */
export const THREAD_USER_PREVIEW_MAX_CHARS = 240;
/** 侧边栏 hover 预览中 AI 回复预览的最大字符数。 */
export const THREAD_ASSISTANT_PREVIEW_MAX_CHARS = 480;

/** 取文本前两行并限制总长，用于侧边栏 hover 预览。 */
export function previewFirstLines(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const joined = trimmed.split("\n").slice(0, 2).join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

export type SessionRemovePolicy = "subtree" | "reparent";

export interface SessionRemoveResult {
  removedThreadIds: string[];
  reparentedThreads: Thread[];
}

/** 可供当前会话选择的模型。 */
export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  thinking: boolean;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DraftModelOption extends ModelOption {
  thinkingLevels: ThinkingLevel[];
}

/** 创建真实 session 前可读取和选择的最小控制配置。 */
export interface DraftSessionConfig {
  models: DraftModelOption[];
  commands: SlashCommand[];
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  readiness: Readiness;
}

/** 首次 prompt materialize session 时原子应用的配置。 */
export interface SessionCreateInput {
  projectId: string;
  /** 经主进程校验、属于该 Project Git 仓库的 worktree 目录。 */
  worktreePath?: string;
  createRequestId: string;
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
}

/** Composer 可补全的 Pi slash command。 */
export interface SlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  /** Desktop 自有命令可声明无需参数；Pi 0.84 RPC 命令不会提供该字段。 */
  acceptsArguments?: boolean;
}

/** 输入给 Pi 的图片。 */
export interface ImageInput {
  name: string;
  mimeType: string;
  data: string;
}

/** 上下文窗口使用情况。 */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Pi 运行前的可用性检查结果。 */
export interface Readiness {
  state: "ready" | "missing-model" | "missing-credentials" | "unavailable-model";
  message?: string;
}

/** 扩展向 Desktop 请求的交互。 */
export interface HostRequest {
  id: string;
  type: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  placeholder?: string;
  /** editor 请求的初始文本。 */
  initialValue?: string;
  options?: string[];
  toolCallId?: string;
  workerInstanceId?: string;
  createdAt: number;
}

/** Desktop 返回给扩展交互请求的结果。 */
export interface HostResponse {
  requestId: string;
  workerInstanceId?: string;
  dismissed?: boolean;
  confirmed?: boolean;
  value?: string;
}

export type PiThreadPhase = "idle" | "running" | "retrying" | "compacting" | "tree-navigation";

export interface PiTimelineNodeBase {
  id: string;
  parentId: string | null;
  sourceEntryId?: string;
  createdAt: number;
  label?: string;
}

export type PiUserContentPart = { type: "text"; text: string } | ({ type: "image" } & SessionImageResourceRef);

/** timeline 中携带的轻量图像资源引用；主体按需经 sessions.readImageResource 读取。 */
export interface SessionImageResourceRef {
  resourceId: string;
  mimeType: string;
}

/** 图像资源主体（base64 data），仅经 readImageResource 单图返回，不进 timeline/bootstrap。 */
export interface SessionImageResource extends SessionImageResourceRef {
  data: string;
}

/** A snapshot of assistant text selected for the next user message. */
export interface PiQuote {
  text: string;
  messageId: string;
  /** Optional metadata labels rendered above the quote text (for example browser annotation context). */
  tags?: string[];
}

export interface PiUserMessage extends PiTimelineNodeBase {
  kind: "user";
  content: PiUserContentPart[];
  /** Legacy single quote retained for persisted sessions. */
  quote?: PiQuote;
  /** Multiple selected text references attached to a user prompt. */
  quotes?: PiQuote[];
  delivery: { state: "live"; requestId?: string; queueId?: string } | { state: "persisted" };
}

export type PiAssistantStatus =
  | { type: "running" }
  | { type: "complete"; reason: "stop" | "unknown" }
  | { type: "incomplete"; reason: "cancelled" | "length" | "error" | "other"; error?: JsonValue };

export interface PiAssistantProvenance {
  api: string;
  provider: string;
  model: string;
  /** 该轮 run 使用的思考等级（由 projector 按会话 thinking_level_change 记录回放）。 */
  thinkingLevel?: ThinkingLevel;
  responseModel?: string;
  responseId?: string;
}

export interface PiAssistantUsage {
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
}

export interface PiToolCallPart {
  id: string;
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { [key: string]: JsonValue };
  argsText: string;
  execution: "streaming-args" | "waiting" | "running" | "complete" | "error";
  partialResult?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
}

export interface PiExtensionNotification {
  customType: string;
  details?: JsonValue;
}

export interface PiAssistantNotificationPart {
  id: string;
  type: "notification";
  notificationType: "info" | "warning" | "error";
  text: string;
  extensionNotification?: PiExtensionNotification;
  createdAt: number;
}

export type PiAssistantPart =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | PiToolCallPart
  | PiAssistantNotificationPart;

export interface PiAssistantMessage extends PiTimelineNodeBase {
  kind: "assistant";
  completedAt?: number;
  content: PiAssistantPart[];
  status: PiAssistantStatus;
  provenance: PiAssistantProvenance;
  usage: PiAssistantUsage;
  diagnostics?: JsonValue;
}

export type PiNoticeContent =
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
  | { type: "custom"; customType: string; content: PiUserContentPart[]; details?: JsonValue };

export interface PiNoticeMessage extends PiTimelineNodeBase {
  kind: "notice";
  noticeType: "bash" | "custom" | "compaction" | "branch-summary" | "notification";
  notificationType?: "info" | "warning" | "error";
  extensionNotification?: PiExtensionNotification;
  title: string;
  content: PiNoticeContent;
  metadata?: JsonValue;
}

export type PiTimelineNode = PiUserMessage | PiAssistantMessage | PiNoticeMessage;

export interface PiQueueItem {
  id: string;
  mode: "steer" | "followUp";
  prompt: string;
  source: "desktop" | "pi-observed";
  requestId?: string;
  createdAt?: number;
}

export interface PiThreadSnapshot {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  cursor: number;
  headId: string | null;
  nodes: readonly PiTimelineNode[];
  queue: readonly PiQueueItem[];
  phase: PiThreadPhase;
  /** 下一条 assistant 消息使用的思考等级；消息开始后固化到 provenance。 */
  thinkingLevel: ThinkingLevel;
  activeTurnId?: string;
  /** `turn_start` 时固化，避免运行中设置污染当前 provider 请求的 provenance。 */
  activeTurnThinkingLevel?: ThinkingLevel;
}

export interface PiRpcExtensionError {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
}

/** Pi 0.84.2 RPC strips cumulative `partial` from assistant message updates. */
type PiAgentMessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type PiRpcAssistantMessageEvent = PiAgentMessageUpdateEvent["assistantMessageEvent"] extends infer Event
  ? Event extends { partial: unknown }
    ? Omit<Event, "partial">
    : Event
  : never;

export type PiRpcMessageUpdateEvent = {
  type: "message_update";
  usage: Extract<PiAgentMessageUpdateEvent["message"], { role: "assistant" }>["usage"];
  assistantMessageEvent: PiRpcAssistantMessageEvent;
};

/** Pi RPC stdout 的公共原子事件集合。Desktop 不维护第二套 timeline event 协议。 */
export type PiRpcEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | PiRpcMessageUpdateEvent
  | RpcExtensionUIRequest
  | PiRpcExtensionError;

/** 低频更新的 Pi 会话控制面，不携带消息历史。 */
export interface SessionControlState {
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  projectId: string;
  threadId: string;
  title: string;
  updatedAt: number;
  cwd: string;
  /** 仅供 thread catalog 展示；active runtime 必须读取 PiThreadSnapshot.phase。 */
  running: boolean;
  /** 活跃 subagent session 由其唯一 writer 投影，Desktop 仅允许只读观察。 */
  interaction?: "read-write" | "read-only";
  retry?: { attempt: number; maxAttempts: number; message: string };
  queueModes: { steering: "all" | "one-at-a-time"; followUp: "all" | "one-at-a-time" };
  model?: { provider: string; id: string; name: string };
  models: ModelOption[];
  commands: SlashCommand[];
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  context?: ContextUsage;
  readiness: Readiness;
  lastError?: string;
  hostRequests: HostRequest[];
  extensionHost: RpcExtensionHostState;
}

/** renderer attach 所需的权威 Pi timeline 与低频控制基线。 */
export interface SessionBootstrap {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  timeline: PiThreadSnapshot;
  /** 基线 snapshot 之后尚未稳定持久化的原始 Pi RPC 事件。 */
  events: readonly { sequence: number; event: PiRpcEvent }[];
  control: SessionControlState;
}

/** main 原子建立窗口订阅后返回的 session 基线。 */
export type SessionCreateIpcResult = SessionBootstrap;

export interface SessionAttachment {
  protocolVersion: typeof PROTOCOL_VERSION;
  attachmentId: string;
  bootstrap: SessionBootstrap;
}

/** A renderer-owned identity. It is intentionally structured instead of encoded in route or transport strings. */
export interface SessionIdentity {
  projectId: string;
  threadId: string;
}

/** Input for one renderer attachment lease. `replaceAttachmentId` is a main-process CAS token. */
export interface SessionAttachInput extends SessionIdentity {
  requestId: string;
  replaceAttachmentId?: string;
}

/** Result of releasing a preload buffer for one attachment lease. */
export type SessionFlushResult = { state: "flushed" } | { state: "recovering"; reason: "preload-buffer-overflow" };

export interface SessionRuntimeAvailability {
  state: "ready" | "recovering" | "unavailable";
  workerInstanceId?: string;
  error?: string;
  reason?: string;
  /** A disconnected mutating request may already have changed the session and must never be replayed automatically. */
  unknownOutcome: boolean;
}

/** main 定向推送给当前 session renderer 的数据。 */
export type SessionPushPayload =
  | { type: "control"; projectId: string; threadId: string; control: SessionControlState }
  | { type: "timeline"; projectId: string; threadId: string; sequence: number; event: PiRpcEvent }
  | {
      type: "runtime-availability";
      projectId: string;
      threadId: string;
      availability: SessionRuntimeAvailability;
    };

/** main 到 preload 的定向推送；attachmentId 隔离快速切换产生的迟到事件。 */
export type SessionPush = SessionPushPayload & {
  attachmentId: string;
  workerInstanceId: string;
  sidecarSequence: number;
};

/** 所有 Composer 输入统一交给 Pi prompt()。 */
export interface SessionPromptInput {
  requestId: string;
  projectId: string;
  threadId: string;
  text: string;
  images: ImageInput[];
  /** Legacy single quote retained for older renderer callers. */
  quote?: PiQuote;
  /** Multiple selected text references attached to this prompt. */
  quotes?: PiQuote[];
  desiredMode?: "steer" | "followUp";
}

export interface SessionCommandResult {
  /** Pi preflight 已接受输入；后续 provider/tool error 不得触发 renderer 重发。 */
  accepted: boolean;
  /** Desktop 在 command 返回时是否观察到该 request 仍位于 Pi queue。 */
  queued: boolean;
  error?: string;
}

/** Project 下的文件树节点。 */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  hasChildren?: boolean;
}

/** Project 下的文本文件。 */
export interface TextFile {
  path: string;
  content: string;
  language: string;
}

/** Project 下的图片文件（data URL，用于只读预览）。 */
export interface FileImage {
  path: string;
  mime: string;
  dataUrl: string;
}

/** OfficeCLI 生成的 Office 文档 HTML 预览。 */
export interface OfficeDocumentPreview {
  path: string;
  html: string;
}

/** Electron 内置查看器使用的 PDF 预览。 */
export interface PdfDocumentPreview {
  path: string;
  url: string;
}

/** 单个 Project 内一次合并的文件变化事件（相对路径，目录树增量刷新用）。 */
export interface FileChangeSet {
  projectId: string;
  added: string[];
  deleted: string[];
  updated: string[];
}

/** 单个 session 下的 PTY 权威快照。 */
export interface TerminalSnapshot {
  projectId: string;
  threadId: string;
  terminalId: string;
  revision: number;
  shell: string;
  output: string;
  running: boolean;
  cols: number;
  rows: number;
}

/** main 向 renderer 推送的 PTY 增量事件。 */
export type TerminalEvent =
  | (Omit<TerminalSnapshot, "output" | "shell" | "running" | "cols" | "rows"> & {
      type: "data";
      data: string;
    })
  | (Omit<TerminalSnapshot, "output" | "shell" | "running" | "cols" | "rows"> & {
      type: "reset";
    })
  | (Omit<TerminalSnapshot, "output" | "shell" | "running" | "cols" | "rows"> & {
      type: "exit";
      exitCode: number;
    });

/** 在 workbench-panel 中注册的一个会话 tab。 */
export interface WorkbenchSessionTab {
  kind: "session";
  /** 会话定位键，等于 sessionRecordKey(projectId, threadId)。 */
  key: string;
  projectId: string;
  threadId: string;
  /** subagent 会话的 agent 身份（原始名称）；普通会话缺省。 */
  agentName?: string;
  /** Tab 展示名（subagent 为内置中文名或原始名称，普通会话为标题）。 */
  displayName: string;
}

/** 在 workbench-panel 中注册的一个内置/扩展 Panel tab。 */
export interface WorkbenchPanelTab {
  kind: "panel";
  panel: string;
}

/** 在 workbench-panel 中注册的一个终端 tab（一个 tab 对应一个终端实例）。 */
export interface WorkbenchTerminalTab {
  kind: "terminal";
  /** 定位键（`terminal:${序号}`），与主进程 PTY 槽位独立。 */
  key: string;
  /** 终端实例 id（主进程 PTY 槽位，projectId+threadId 内唯一）。 */
  terminalId: string;
  /** Tab 展示名（参考 VS Code 终端标签显示名，不含场景语义）。 */
  displayName: string;
}

/** workbench-panel 中注册的 tab：会话/面板/终端，均可关闭。 */
export type WorkbenchTab = WorkbenchSessionTab | WorkbenchPanelTab | WorkbenchTerminalTab;

/** 每个 session 独立持有的 Workbench Panel 布局状态。 */
export interface WorkbenchState {
  projectId: string;
  threadId: string;
  panelOpen: boolean;
  panelWidth: number;
  fileTreeWidth?: number;
  fileWrapMode?: boolean;
  fileMarkdownPreview?: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  /** 侧边栏面板终端的 tab 列表与激活项（跨收起/刷新持久化）。 */
  panelTerminals?: TerminalTabsState;
  /** 底部终端的 tab 列表与激活项。 */
  bottomTerminals?: TerminalTabsState;
  openFiles: string[];
  activeFile?: string;
  /** 处于“预览”状态的 tab（单击打开，可被下一次单击替换）；固定后为 undefined。 */
  previewFile?: string;
  expandedPaths: string[];
  /** 已打开的 workbench panel tab（会话/面板）；由渲染进程写入，跨刷新/重启持久化。 */
  tabs?: WorkbenchTab[];
  /** 当前选中的 tab 键；null 表示展示新建 Panel 缺省页。 */
  activeTabKey?: string | null;
  /** 终端 tab 序号计数器（单调递增，跨刷新/重启持久化，保证 terminalId 不重复）。 */
  terminalTabCounter?: number;
  /** 全屏期间会话 modal 的 UI 状态（渲染进程写入，跨刷新/重启持久化）。 */
  sessionModal?: SessionModalPersistedState;
  /** 会话信息面板开关（会话级 UI 状态，随 WorkbenchState 持久化；缺省为打开）。 */
  sessionInfoOpen?: boolean;
}

/** 全屏会话 modal 的开关与几何状态（session 级 UI 状态，随 WorkbenchState 持久化）。 */
export interface SessionModalPersistedState {
  /** 工作区侧边栏是否处于全屏态。 */
  fullscreen: boolean;
  /** 全屏期间会话 modal 是否打开。 */
  modalOpen: boolean;
  /** modal 相对 Radix 初始定位的拖拽偏移（px）。 */
  drag: { x: number; y: number };
  /** 自定义缩放尺寸；null 表示未缩放（CSS 默认尺寸）。 */
  size: { width: number; height: number } | null;
}

/** 单个终端视图的 tab 状态（多终端 tab 持久化）。 */
export interface TerminalTabsState {
  tabs: string[];
  activeId: string;
}

/** links.open 的解析结果：项目内文件返回 workbench 相对路径，其余由系统/外部打开。 */
export interface OpenLinkResult {
  /** 是否应在应用内（workbench 文件面板）打开。 */
  openInApp: boolean;
  /** openInApp 为 true 时，相对项目 cwd 的规范化路径。 */
  path?: string;
}
