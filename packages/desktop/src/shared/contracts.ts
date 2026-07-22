/** Desktop 与 renderer 之间使用的协议版本。 */
export const PROTOCOL_VERSION = 8;

/** 可以安全通过 Electron IPC 传输的 JSON 值。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 本地工作区项目。 */
export interface Project {
  id: string;
  name: string;
  cwd: string;
  lastOpenedAt: number;
  available: boolean;
  issue?: string;
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
  archived: boolean;
  running: boolean;
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
  createRequestId: string;
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
}

/** Composer 可补全的 Pi slash command。 */
export interface SlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
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
  type: "confirm" | "select" | "input" | "editor" | "notify";
  title: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  notifyType?: "info" | "warning" | "error";
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

/** 扩展对 Desktop 工作台的非阻塞 UI 状态。 */
export interface ExtensionUiState {
  statuses: Record<string, string>;
  workingMessage?: string;
  workingVisible: boolean;
  hiddenThinkingLabel?: string;
  windowTitle?: string;
  editorText?: string;
  /** Extension setEditorText/pasteToEditor 的命令序号；renderer 只应用新序号。 */
  editorRevision: number;
  toolsExpanded: boolean;
  widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

export type PiThreadPhase = "idle" | "running" | "retrying" | "compacting" | "tree-navigation";

export interface PiTimelineNodeBase {
  id: string;
  parentId: string | null;
  sourceEntryId?: string;
  createdAt: number;
  label?: string;
}

export type PiUserContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PiUserMessage extends PiTimelineNodeBase {
  kind: "user";
  content: PiUserContentPart[];
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

export interface PiAssistantNotificationPart {
  id: string;
  type: "notification";
  notificationType: "info" | "warning" | "error";
  text: string;
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
  activeTurnId?: string;
}

export type PiThreadEvent =
  | { type: "phase-changed"; phase: PiThreadPhase; activeTurnId?: string }
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

export interface PiThreadEventEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  sequence: number;
  event: PiThreadEvent;
}

export interface PiThreadEventBatch {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  fromSequence: number;
  toSequence: number;
  events: readonly PiThreadEventEnvelope[];
}

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
  extensionUi: ExtensionUiState;
}

/** renderer attach 所需的权威 Pi timeline 与低频控制基线。 */
export interface SessionBootstrap {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  timeline: PiThreadSnapshot;
  control: SessionControlState;
}

/** main 原子建立窗口订阅后返回的 session 基线。 */
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
  | { type: "timeline"; projectId: string; threadId: string; batch: PiThreadEventBatch }
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
  desiredMode?: "steer" | "followUp";
}

export interface SessionEditInput extends SessionPromptInput {
  sourceId: string;
}

export interface SessionReloadInput {
  requestId: string;
  projectId: string;
  threadId: string;
  parentId: string | null;
}

/** 在指定 entry 处 fork 当前 session 为新 session 文件。position 默认 "at"。 */
export interface SessionBranchInput {
  requestId: string;
  projectId: string;
  threadId: string;
  sourceEntryId: string;
  position?: "at" | "before";
}

export interface SessionBranchResult {
  branchThreadId: string;
  branchSessionFile: string;
}

export interface SessionCommandResult {
  /** Pi preflight 已接受输入；后续 provider/tool error 不得触发 renderer 重发。 */
  accepted: boolean;
  /** Desktop 在 command 返回时是否观察到该 request 仍位于 Pi queue。 */
  queued: boolean;
  error?: string;
}

export interface ClearedQueue {
  steering: string[];
  followUp: string[];
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

/** 每个 session 独立持有的 Workbench Panel 布局状态。 */
export interface WorkbenchState {
  projectId: string;
  threadId: string;
  panel: "chat" | "terminal" | "files" | "tasks";
  panelOpen: boolean;
  panelWidth: number;
  terminalOpen: boolean;
  terminalHeight: number;
  openFiles: string[];
  activeFile?: string;
  expandedPaths: string[];
}
