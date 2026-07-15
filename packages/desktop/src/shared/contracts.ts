/** Desktop 与 renderer 之间使用的协议版本。 */
export const PROTOCOL_VERSION = 1;

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

/** 文本消息片段。 */
export interface TextPart {
	type: "text";
	text: string;
}

/** 推理消息片段。 */
export interface ReasoningPart {
	type: "reasoning";
	text: string;
	redacted?: boolean;
}

/** 图片消息片段。 */
export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

/** 工具调用消息片段。 */
export interface ToolPart {
	type: "tool";
	id: string;
	name: string;
	args: JsonValue;
	result?: string;
	status: "running" | "complete" | "error";
}

/** renderer 使用的消息片段。 */
export type MessagePart = TextPart | ReasoningPart | ImagePart | ToolPart;

/** renderer 使用的稳定消息结构。 */
export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	parts: MessagePart[];
	timestamp: number;
	status: "running" | "complete" | "cancelled" | "error";
	error?: string;
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

/** 单个 Pi 会话的权威快照。 */
export interface SessionSnapshot {
	protocolVersion: typeof PROTOCOL_VERSION;
	revision: number;
	projectId: string;
	threadId: string;
	title: string;
	cwd: string;
	messages: ChatMessage[];
	running: boolean;
	compacting: boolean;
	retry?: { attempt: number; maxAttempts: number; message: string };
	queue: { steering: string[]; followUp: string[] };
	model?: { provider: string; id: string; name: string };
	models: ModelOption[];
	commands: SlashCommand[];
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	thinkingLevels: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
	context?: ContextUsage;
	readiness: Readiness;
	lastError?: string;
	hostRequests: HostRequest[];
	extensionUi: ExtensionUiState;
}

/** 发送消息时的运行模式。 */
export type SendMode = "prompt" | "steer" | "followUp";

/** 发送给 Pi 的消息。 */
export interface SendInput {
	projectId: string;
	threadId: string;
	text: string;
	mode: SendMode;
	images: ImageInput[];
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
