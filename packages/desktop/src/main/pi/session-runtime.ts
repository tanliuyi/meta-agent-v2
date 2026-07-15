import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ChatMessage, PROTOCOL_VERSION, type SendInput, type SessionSnapshot } from "../../shared/contracts.ts";
import { HostUi } from "./host-ui.ts";
import { projectMessages, resultText, type ToolState, toJson } from "./message-projector.ts";
import { getSessionCommands, parseDesktopCommand } from "./session-commands.ts";

interface RuntimeOptions {
	projectId: string;
	cwd: string;
	sessionManager?: SessionManager;
	changed(snapshot: SessionSnapshot): void;
}

/** 单个 Pi AgentSession 的本地生命周期和权威快照。 */
export class SessionRuntime {
	private readonly tools = new Map<string, ToolState>();
	private readonly hostUi: HostUi;
	private revision = 0;
	private compacting = false;
	private retry?: SessionSnapshot["retry"];
	private lastError?: string;
	private timer?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	readonly projectId: string;
	readonly cwd: string;
	readonly session: AgentSession;
	private readonly models: ModelRegistry;
	private readonly changed: (snapshot: SessionSnapshot) => void;

	private constructor(
		projectId: string,
		cwd: string,
		session: AgentSession,
		models: ModelRegistry,
		changed: (snapshot: SessionSnapshot) => void,
	) {
		this.projectId = projectId;
		this.cwd = cwd;
		this.session = session;
		this.models = models;
		this.changed = changed;
		this.hostUi = new HostUi(
			() => this.publish(),
			() => [...this.session.state.pendingToolCalls],
		);
	}

	/** 创建新会话或从指定 SessionManager 恢复会话。 */
	static async create(options: RuntimeOptions): Promise<SessionRuntime> {
		const agentDir = getAgentDir();
		const auth = AuthStorage.create(join(agentDir, "auth.json"));
		const models = ModelRegistry.create(auth, join(agentDir, "models.json"));
		const settings = SettingsManager.create(options.cwd, agentDir);
		const result = await createAgentSession({
			cwd: options.cwd,
			sessionManager: options.sessionManager,
			modelRegistry: models,
			authStorage: auth,
			settingsManager: settings,
			sessionStartEvent: {
				type: "session_start",
				reason: options.sessionManager ? "resume" : "new",
			},
		});
		const runtime = new SessionRuntime(options.projectId, options.cwd, result.session, models, options.changed);
		runtime.lastError = result.modelFallbackMessage;
		await result.session.bindExtensions({
			uiContext: runtime.hostUi.createContext(),
			mode: "rpc",
			onError: (error) => {
				runtime.lastError = `${error.extensionPath}: ${error.error}`;
				runtime.publish();
			},
		});
		runtime.unsubscribe = result.session.subscribe((event) => runtime.onEvent(event));
		return runtime;
	}

	/** 当前 Pi session id。 */
	get id(): string {
		return this.session.sessionId;
	}

	/** 当前 session 文件路径，首次写入前可能为空。 */
	get file(): string | undefined {
		return this.session.sessionFile;
	}

	/** 生成 renderer 恢复所需的完整权威快照。 */
	snapshot(): SessionSnapshot {
		const model = this.session.model;
		const available = this.models.getAvailable();
		const context = this.session.getContextUsage();
		const messages = projectMessages(this.session, this.tools);
		return {
			protocolVersion: PROTOCOL_VERSION,
			revision: this.revision,
			projectId: this.projectId,
			threadId: this.id,
			title: this.title(messages),
			cwd: this.cwd,
			messages,
			running: this.session.isStreaming,
			compacting: this.compacting,
			retry: this.retry,
			queue: {
				steering: [...this.session.getSteeringMessages()],
				followUp: [...this.session.getFollowUpMessages()],
			},
			model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
			models: available.map((item) => ({
				provider: item.provider,
				id: item.id,
				name: item.name,
				contextWindow: item.contextWindow,
				thinking: item.reasoning,
			})),
			commands: getSessionCommands(this.session),
			thinkingLevel: this.session.thinkingLevel,
			thinkingLevels: this.session.getAvailableThinkingLevels(),
			context: context
				? { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent }
				: undefined,
			readiness: readiness(Boolean(model), available.length, this.models.getAll().length),
			lastError: this.lastError ?? this.session.state.errorMessage,
			hostRequests: this.hostUi.requests,
			extensionUi: this.hostUi.uiState,
		};
	}

	/** 向 Pi 发送普通、steer 或 follow-up 输入。 */
	async send(input: SendInput): Promise<void> {
		const images = input.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
		this.lastError = undefined;
		if (images.length === 0 && (await this.runDesktopCommand(input.text))) return;
		await this.session.prompt(input.text, {
			images,
			streamingBehavior: input.mode === "prompt" ? undefined : input.mode,
		});
	}

	/** 停止当前运行。 */
	async cancel(): Promise<void> {
		await this.session.abort();
	}

	/** 清空队列并返回可恢复到 Composer 的文本。 */
	clearQueue(): string[] {
		const queue = this.session.clearQueue();
		return [...queue.steering, ...queue.followUp];
	}

	/** 手动压缩当前上下文。 */
	async compact(): Promise<void> {
		await this.session.compact();
	}

	/** 切换当前会话模型。 */
	async setModel(provider: string, modelId: string): Promise<void> {
		const model = this.models.find(provider, modelId);
		if (!model) throw new Error(`模型不存在: ${provider}/${modelId}`);
		await this.session.setModel(model);
		this.publish();
	}

	/** 切换当前会话 thinking level。 */
	setThinking(level: SessionSnapshot["thinkingLevel"]): void {
		this.session.setThinkingLevel(level);
		this.publish();
	}

	/** 重命名当前会话。 */
	rename(title: string): void {
		this.session.setSessionName(title.trim());
	}

	/** 响应扩展发起的阻塞式 UI 请求。 */
	respond(response: Parameters<HostUi["respond"]>[0]): void {
		this.hostUi.respond(response);
	}

	/** 释放 session，不用于普通的前台会话切换。 */
	async dispose(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		if (this.session.isStreaming) await this.session.abort();
		this.unsubscribe?.();
		this.hostUi.dispose();
		this.session.dispose();
	}

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start") {
			this.tools.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: toJson(event.args),
				status: "running",
			});
		} else if (event.type === "tool_execution_update") {
			this.tools.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: toJson(event.args),
				result: resultText(event.partialResult),
				status: "running",
			});
		} else if (event.type === "tool_execution_end") {
			const current = this.tools.get(event.toolCallId);
			this.tools.set(event.toolCallId, {
				id: event.toolCallId,
				name: event.toolName,
				args: current?.args ?? {},
				result: resultText(event.result),
				status: event.isError ? "error" : "complete",
			});
		} else if (event.type === "compaction_start") {
			this.compacting = true;
		} else if (event.type === "compaction_end") {
			this.compacting = false;
			this.lastError = event.errorMessage;
		} else if (event.type === "auto_retry_start") {
			this.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, message: event.errorMessage };
		} else if (event.type === "auto_retry_end") {
			this.retry = undefined;
			this.lastError = event.finalError;
		} else if (event.type === "agent_end" && !event.willRetry) {
			this.retry = undefined;
		}

		if (event.type === "message_update" || event.type === "tool_execution_update") this.publishSoon();
		else this.publish();
	}

	private publishSoon(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.publish();
		}, 32);
	}

	private publish(): void {
		this.revision += 1;
		this.changed(this.snapshot());
	}

	private async runDesktopCommand(text: string): Promise<boolean> {
		const command = parseDesktopCommand(text);
		if (!command) return false;
		if (command.name === "compact") await this.compact();
		else if (command.name === "reload") await this.session.reload();
		else {
			if (!command.title) throw new Error("用法: /name <会话名称>");
			this.rename(command.title);
		}
		this.publish();
		return true;
	}

	private title(messages: ChatMessage[]): string {
		if (this.session.sessionName) return this.session.sessionName;
		const first = messages.find(({ role }) => role === "user");
		const text = first?.parts.find(({ type }) => type === "text");
		return text?.type === "text" && text.text.trim() ? text.text.trim().slice(0, 48) : "新会话";
	}
}

function readiness(hasModel: boolean, availableCount: number, allCount: number): SessionSnapshot["readiness"] {
	if (hasModel) return { state: "ready" };
	if (allCount === 0) return { state: "missing-model", message: "Pi 没有可用模型配置" };
	if (availableCount === 0) return { state: "missing-credentials", message: "请先在 Pi 中配置模型凭据" };
	return { state: "unavailable-model", message: "当前会话模型不可用，请选择其他模型" };
}
