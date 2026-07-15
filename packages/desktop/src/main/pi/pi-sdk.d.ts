declare module "@earendil-works/pi-coding-agent" {
	export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

	export interface ExtensionUIDialogOptions {
		timeout?: number;
		signal?: AbortSignal;
	}

	export interface ExtensionWidgetOptions {
		placement?: "aboveEditor" | "belowEditor";
	}

	export interface ExtensionUIContext {
		select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
		confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
		input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
		setStatus(key: string, text: string | undefined): void;
		setWorkingMessage(message?: string): void;
		setWorkingVisible(visible: boolean): void;
		setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
		setHiddenThinkingLabel(label?: string): void;
		setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void;
		setFooter(factory: unknown): void;
		setHeader(factory: unknown): void;
		setTitle(title: string): void;
		custom<T>(factory: unknown, options?: unknown): Promise<T>;
		pasteToEditor(text: string): void;
		setEditorText(text: string): void;
		getEditorText(): string;
		addAutocompleteProvider(factory: unknown): void;
		setEditorComponent(factory: unknown): void;
		getEditorComponent(): unknown;
		readonly theme: unknown;
		getAllThemes(): { name: string; path: string | undefined }[];
		getTheme(name: string): unknown;
		setTheme(theme: unknown): { success: boolean; error?: string };
		getToolsExpanded(): boolean;
		setToolsExpanded(expanded: boolean): void;
	}

	export interface PiModel {
		provider: string;
		id: string;
		name: string;
		contextWindow: number;
		reasoning: boolean;
	}

	export interface PiSlashCommand {
		invocationName: string;
		description?: string;
	}

	export interface PiPromptTemplate {
		name: string;
		description?: string;
	}

	export interface PiSkill {
		name: string;
		description?: string;
	}

	export interface PiExtensionRunner {
		getRegisteredCommands(): PiSlashCommand[];
	}

	export interface PiResourceLoader {
		getSkills(): { skills: PiSkill[] };
	}

	export interface PiTextContent {
		type: "text";
		text: string;
	}

	export interface PiThinkingContent {
		type: "thinking";
		thinking: string;
		redacted?: boolean;
	}

	export interface PiImageContent {
		type: "image";
		data: string;
		mimeType: string;
	}

	export interface PiToolCall {
		type: "toolCall";
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}

	export type PiMessage =
		| { role: "user"; content: string | Array<PiTextContent | PiImageContent>; timestamp: number }
		| {
				role: "assistant";
				content: Array<PiTextContent | PiThinkingContent | PiToolCall>;
				stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
				errorMessage?: string;
				timestamp: number;
		  }
		| {
				role: "toolResult";
				toolCallId: string;
				toolName: string;
				content: Array<PiTextContent | PiImageContent>;
				isError: boolean;
				timestamp: number;
		  };

	export type AgentSessionEvent =
		| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
		| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
		| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
		| { type: "message_update" }
		| { type: "compaction_start" }
		| { type: "compaction_end"; errorMessage?: string }
		| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
		| { type: "auto_retry_end"; finalError?: string }
		| { type: "agent_end"; willRetry: boolean }
		| { type: "agent_start" | "agent_settled" | "queue_update" | "message_start" | "message_end" }
		| { type: "turn_start" | "turn_end" | "entry_appended" | "session_info_changed" | "thinking_level_changed" };

	export interface SessionInfo {
		path: string;
		id: string;
		cwd: string;
		name?: string;
		created: Date;
		modified: Date;
		messageCount: number;
		firstMessage: string;
		allMessagesText: string;
	}

	export class SessionManager {
		static list(cwd: string, sessionDir?: string): Promise<SessionInfo[]>;
		static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
		getSessionFile(): string | undefined;
		appendSessionInfo(name: string): string;
	}

	// biome-ignore lint/complexity/noStaticOnlyClass: Mirrors the runtime Pi SDK class while exposing only the used API.
	export class AuthStorage {
		static create(path?: string): AuthStorage;
	}

	export class ModelRegistry {
		static create(auth: AuthStorage, path?: string): ModelRegistry;
		getAll(): PiModel[];
		getAvailable(): PiModel[];
		find(provider: string, modelId: string): PiModel | undefined;
	}

	// biome-ignore lint/complexity/noStaticOnlyClass: Mirrors the runtime Pi SDK class while exposing only the used API.
	export class SettingsManager {
		static create(cwd?: string, agentDir?: string): SettingsManager;
	}

	export interface AgentSession {
		readonly sessionId: string;
		readonly sessionFile: string | undefined;
		readonly sessionName: string | undefined;
		readonly sessionManager: SessionManager;
		readonly messages: PiMessage[];
		readonly promptTemplates: ReadonlyArray<PiPromptTemplate>;
		readonly extensionRunner: PiExtensionRunner;
		readonly resourceLoader: PiResourceLoader;
		readonly model: PiModel | undefined;
		readonly thinkingLevel: ThinkingLevel;
		readonly isStreaming: boolean;
		readonly state: {
			pendingToolCalls: ReadonlySet<string>;
			errorMessage?: string;
		};
		bindExtensions(bindings: {
			uiContext?: ExtensionUIContext;
			mode?: "tui" | "rpc" | "json" | "print";
			onError?(error: { extensionPath: string; error: string }): void;
		}): Promise<void>;
		subscribe(listener: (event: AgentSessionEvent) => void): () => void;
		prompt(
			text: string,
			options?: { images?: PiImageContent[]; streamingBehavior?: "steer" | "followUp" },
		): Promise<void>;
		steer(text: string, images?: PiImageContent[]): Promise<void>;
		followUp(text: string, images?: PiImageContent[]): Promise<void>;
		abort(): Promise<void>;
		clearQueue(): { steering: string[]; followUp: string[] };
		getSteeringMessages(): readonly string[];
		getFollowUpMessages(): readonly string[];
		compact(customInstructions?: string): Promise<unknown>;
		reload(): Promise<void>;
		setModel(model: PiModel): Promise<void>;
		setThinkingLevel(level: ThinkingLevel): void;
		getAvailableThinkingLevels(): ThinkingLevel[];
		getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
		setSessionName(name: string): void;
		dispose(): void;
	}

	export interface CreateAgentSessionResult {
		session: AgentSession;
		modelFallbackMessage?: string;
	}

	export function createAgentSession(options?: {
		cwd?: string;
		sessionManager?: SessionManager;
		modelRegistry?: ModelRegistry;
		authStorage?: AuthStorage;
		settingsManager?: SettingsManager;
		sessionStartEvent?: { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork" };
	}): Promise<CreateAgentSessionResult>;

	export function getAgentDir(): string;
}
