import type { BaseEvent, Message, RunAgentInput, State } from "@ag-ui/core";

/** Desktop 与 renderer 之间使用的协议版本。 */
export const PROTOCOL_VERSION = 3;

/** Pi 开始消费排队 user message 时发送的有序 AG-UI 事件名。 */
export const CONSUMED_USER_MESSAGE_EVENT = "desktop.user-message-consumed";

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
  model: { provider: string; id: string; name: string } | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  readiness: Readiness;
}

/** 首次 prompt materialize session 时原子应用的配置。 */
export interface SessionCreateInput {
  projectId: string;
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
  createdAt: number;
}

/** Desktop 返回给扩展交互请求的结果。 */
export interface HostResponse {
  requestId: string;
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
  toolsExpanded: boolean;
  widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

/** 低频更新的 Pi 会话控制面，不携带消息历史。 */
export interface SessionControlState {
  protocolVersion: typeof PROTOCOL_VERSION;
  revision: number;
  projectId: string;
  threadId: string;
  title: string;
  cwd: string;
  running: boolean;
  compacting: boolean;
  retry?: { attempt: number; maxAttempts: number; message: string };
  queue: { steering: string[]; followUp: string[] };
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

/** renderer 建立或恢复 AG-UI runtime 所需的权威基线。 */
export interface SessionBootstrap {
  protocolVersion: typeof PROTOCOL_VERSION;
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

/** main 原子建立窗口订阅后返回的 session 基线。 */
export interface SessionAttachment {
  protocolVersion: typeof PROTOCOL_VERSION;
  attachmentId: string;
  bootstrap: SessionBootstrap;
}

/** Electron 传输层为单个 AG-UI 事件补充的顺序信息。 */
export interface SessionEventEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  runId?: string;
  sequence: number;
  event: BaseEvent;
}

/** 一个 session 在单个渲染帧内产生的有序 AG-UI 事件。 */
export interface SessionEventBatch {
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  threadId: string;
  fromSequence: number;
  toSequence: number;
  events: SessionEventEnvelope[];
}

/** AG-UI 标准 tool result 之外的 Desktop 展示状态。 */
export interface SessionToolUpdate {
  toolCallId: string;
  status: "running" | "complete" | "error";
  result?: string;
}

/** main 定向推送给当前 session renderer 的数据。 */
export type SessionPushPayload =
  | { type: "control"; projectId: string; threadId: string; control: SessionControlState }
  | { type: "tool"; projectId: string; threadId: string; update: SessionToolUpdate }
  | { type: "events"; projectId: string; threadId: string; batch: SessionEventBatch };

/** main 到 preload 的定向推送；attachmentId 隔离快速切换产生的迟到事件。 */
export type SessionPush = SessionPushPayload & { attachmentId: string };

/** 发送消息时的运行模式。 */
export type SendMode = "steer" | "followUp";

/** 发送给 Pi 的消息。 */
export interface SendInput {
  projectId: string;
  threadId: string;
  text: string;
  mode: SendMode;
  images: ImageInput[];
}

/** assistant-ui 官方 runtime 发起的新 AG-UI run。 */
export interface SessionRunInput {
  projectId: string;
  threadId: string;
  input: RunAgentInput;
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
