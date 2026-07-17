import type { Message, RunAgentInput } from "@ag-ui/core";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  type ModelRegistry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  type SendInput,
  type SessionBootstrap,
  type SessionControlState,
  type SessionCreateInput,
  type SessionPushPayload,
  type Thread,
} from "../../shared/contracts.ts";
import { HostUi } from "./host-ui.ts";
import { projectMessages } from "./message-projector.ts";
import { PiAgUiAdapter } from "./pi-ag-ui-adapter.ts";
import { getSessionCommands, parseDesktopCommand } from "./session-commands.ts";
import {
  createSessionConfigurationServices,
  resolveSessionCreateSelection,
  sessionReadiness,
} from "./session-configuration.ts";

interface RuntimeOptions {
  projectId: string;
  cwd: string;
  sessionManager?: SessionManager;
  createInput?: SessionCreateInput;
  push(update: SessionPushPayload): void;
  onSummaryChanged(runtime: SessionRuntime): void;
}

/** 单个 Pi AgentSession 的生命周期、控制面与 AG-UI 数据面。 */
export class SessionRuntime {
  private readonly hostUi: HostUi;
  private readonly adapter: PiAgUiAdapter;
  private revision = 0;
  private compacting = false;
  private retry?: SessionControlState["retry"];
  private lastError?: string;
  private unsubscribe?: () => void;
  private summaryState: Omit<Thread, "projectId" | "archived" | "running">;
  readonly projectId: string;
  readonly cwd: string;
  readonly session: AgentSession;
  private readonly models: ModelRegistry;
  private readonly push: (update: SessionPushPayload) => void;
  private readonly onSummaryChanged: (runtime: SessionRuntime) => void;

  private constructor(
    projectId: string,
    cwd: string,
    session: AgentSession,
    models: ModelRegistry,
    push: (update: SessionPushPayload) => void,
    onSummaryChanged: (runtime: SessionRuntime) => void,
  ) {
    this.projectId = projectId;
    this.cwd = cwd;
    this.session = session;
    this.models = models;
    this.push = push;
    this.onSummaryChanged = onSummaryChanged;
    this.hostUi = new HostUi(
      () => this.publishControl(),
      () => [...this.session.state.pendingToolCalls],
    );
    this.adapter = new PiAgUiAdapter({
      projectId,
      session,
      onEvents: (batch) => this.push({ type: "events", projectId, threadId: this.id, batch }),
      onTool: (update) => this.push({ type: "tool", projectId, threadId: this.id, update }),
    });
    this.summaryState = createSummary(session);
  }

  /** 创建新会话或从指定 SessionManager 恢复会话。 */
  static async create(options: RuntimeOptions): Promise<SessionRuntime> {
    const { auth, models, settings } = createSessionConfigurationServices(options.cwd);
    const selection = options.createInput ? resolveSessionCreateSelection(options.createInput, models) : undefined;
    const result = await createAgentSession({
      cwd: options.cwd,
      sessionManager: options.sessionManager,
      modelRegistry: models,
      authStorage: auth,
      settingsManager: settings,
      ...(selection ? { model: selection.model, thinkingLevel: selection.thinkingLevel } : {}),
      sessionStartEvent: { type: "session_start", reason: options.sessionManager ? "resume" : "new" },
    });
    const runtime = new SessionRuntime(
      options.projectId,
      options.cwd,
      result.session,
      models,
      options.push,
      options.onSummaryChanged,
    );
    runtime.lastError = result.modelFallbackMessage;
    await result.session.bindExtensions({
      uiContext: runtime.hostUi.createContext(),
      mode: "rpc",
      onError: (error) => {
        runtime.lastError = `${error.extensionPath}: ${error.error}`;
        runtime.publishControl();
      },
    });
    runtime.unsubscribe = result.session.subscribe((event) => runtime.onEvent(event));
    return runtime;
  }

  get id(): string {
    return this.session.sessionId;
  }

  get file(): string | undefined {
    return this.session.sessionFile;
  }

  /** 首次打开、reload 或 sequence 失步时返回完整 AG-UI 基线。 */
  bootstrap(): SessionBootstrap {
    const active = this.adapter.activeRunBootstrap;
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.id,
      cursor: this.adapter.currentSequence,
      control: this.control(),
      messages: active?.messages ?? projectMessages(this.session),
      state: {},
      ...(active ? { activeRun: { runId: active.runId, events: active.events } } : {}),
    };
  }

  /** 列表页使用的 O(1) 运行时摘要。 */
  threadSummary(archived: boolean): Thread {
    return {
      ...this.summaryState,
      projectId: this.projectId,
      archived,
      running: this.session.isStreaming,
    };
  }

  /** 发起 assistant-ui 标准 AG-UI run。 */
  async run(input: RunAgentInput): Promise<void> {
    if (input.threadId !== this.id) throw new Error(`AG-UI threadId 不匹配: ${input.threadId}`);
    const user = input.messages.findLast((message) => message.role === "user");
    if (!user) throw new Error("AG-UI run 缺少 user message");
    const { text, images } = userInput(user.content);
    this.lastError = undefined;
    this.adapter.start(input);
    try {
      if (images.length === 0 && (await this.runDesktopCommand(text))) {
        this.adapter.complete();
        return;
      }
      await this.session.prompt(text, { images });
      if (!this.session.isStreaming) this.adapter.complete();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.adapter.fail(error);
      this.publishControl();
      throw error;
    }
  }

  /** 在当前 Pi run 中发送 steer 或 follow-up，不创建并行 AG-UI run。 */
  async enqueue(input: SendInput): Promise<void> {
    const images = input.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
    if (input.mode === "steer") await this.session.steer(input.text, images);
    else await this.session.followUp(input.text, images);
  }

  async cancel(): Promise<void> {
    await this.session.abort();
  }

  clearQueue(): string[] {
    const queue = this.session.clearQueue();
    return [...queue.steering, ...queue.followUp];
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.models.find(provider, modelId);
    if (!model) throw new Error(`模型不存在: ${provider}/${modelId}`);
    await this.session.setModel(model);
    this.publishControl();
  }

  setThinking(level: SessionControlState["thinkingLevel"]): void {
    this.session.setThinkingLevel(level);
    this.publishControl();
  }

  rename(title: string): void {
    this.session.setSessionName(title.trim());
    this.summaryState = { ...this.summaryState, title: title.trim() || "新会话" };
    this.publishControl();
    this.onSummaryChanged(this);
  }

  respond(response: Parameters<HostUi["respond"]>[0]): void {
    this.hostUi.respond(response);
  }

  async dispose(): Promise<void> {
    if (this.session.isStreaming) await this.session.abort();
    this.unsubscribe?.();
    this.adapter.dispose();
    this.hostUi.dispose();
    this.session.dispose();
  }

  private control(): SessionControlState {
    const model = this.session.model;
    const available = this.models.getAvailable();
    const context = this.session.getContextUsage();
    return {
      protocolVersion: PROTOCOL_VERSION,
      revision: this.revision,
      projectId: this.projectId,
      threadId: this.id,
      title: this.summaryState.title,
      cwd: this.cwd,
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
      readiness: sessionReadiness(Boolean(model), available.length, this.models.getAll().length),
      lastError: this.lastError ?? this.session.state.errorMessage,
      hostRequests: this.hostUi.requests,
      extensionUi: this.hostUi.uiState,
    };
  }

  private onEvent(event: AgentSessionEvent): void {
    this.adapter.handle(event);
    let publish = false;
    if (event.type === "compaction_start") {
      this.compacting = true;
      publish = true;
    } else if (event.type === "compaction_end") {
      this.compacting = false;
      this.lastError = event.errorMessage;
      publish = true;
    } else if (event.type === "auto_retry_start") {
      this.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, message: event.errorMessage };
      publish = true;
    } else if (event.type === "auto_retry_end") {
      this.retry = undefined;
      this.lastError = event.finalError;
      publish = true;
    } else if (event.type === "agent_end" && !event.willRetry) {
      this.retry = undefined;
    } else if (
      event.type === "agent_start" ||
      event.type === "agent_settled" ||
      event.type === "queue_update" ||
      event.type === "thinking_level_changed"
    ) {
      publish = true;
    }

    if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant")) {
      const previousTitle = this.summaryState.title;
      this.updateSummary(event.message);
      this.onSummaryChanged(this);
      if (this.summaryState.title !== previousTitle) publish = true;
    }
    if (event.type === "session_info_changed") {
      this.summaryState = { ...this.summaryState, title: event.name?.trim() || this.summaryState.title };
      this.onSummaryChanged(this);
      publish = true;
    }
    if (event.type === "agent_settled") this.onSummaryChanged(this);
    if (publish) this.publishControl();
  }

  private publishControl(): void {
    this.revision += 1;
    this.push({ type: "control", projectId: this.projectId, threadId: this.id, control: this.control() });
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
    return true;
  }

  private updateSummary(message: AgentSession["messages"][number]): void {
    const preview =
      message.role === "user" && !this.summaryState.preview
        ? contentText(message.content).slice(0, 120)
        : this.summaryState.preview;
    const title =
      this.session.sessionName ||
      (this.summaryState.preview ? this.summaryState.title : preview.slice(0, 48)) ||
      "新会话";
    this.summaryState = {
      ...this.summaryState,
      title,
      preview,
      updatedAt: message.timestamp,
      messageCount: this.summaryState.messageCount + 1,
    };
  }
}

function createSummary(session: AgentSession): Omit<Thread, "projectId" | "archived" | "running"> {
  const visible = session.messages.filter((message) => message.role === "user" || message.role === "assistant");
  const first = visible.find((message) => message.role === "user");
  const preview = first?.role === "user" ? contentText(first.content).slice(0, 120) : "";
  return {
    id: session.sessionId,
    title: session.sessionName || preview.slice(0, 48) || "新会话",
    createdAt: visible[0]?.timestamp ?? Date.now(),
    updatedAt: visible.at(-1)?.timestamp ?? Date.now(),
    messageCount: visible.length,
    preview,
  };
}

function userInput(content: Extract<Message, { role: "user" }>["content"]): {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
} {
  if (typeof content === "string") return { text: content, images: [] };
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const images = content.flatMap((part) => {
    if (part.type !== "image" || part.source.type !== "data") return [];
    return [{ type: "image" as const, data: part.source.value, mimeType: part.source.mimeType }];
  });
  return { text, images };
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}
