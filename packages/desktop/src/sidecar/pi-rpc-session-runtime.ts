import { delimiter, dirname } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { projectPersistedBranch } from "../main/pi/pi-thread-projector.ts";
import { withQuoteContext } from "../main/pi/quote-context.ts";
import type {
  ContextUsage,
  HostRequest,
  HostResponse,
  ModelOption,
  PiNoticeMessage,
  PiQueueItem,
  PiRpcEvent,
  PiThreadPhase,
  PiThreadSnapshot,
  PiTimelineNode,
  Readiness,
  SessionBootstrap,
  SessionCommandResult,
  SessionControlState,
  SessionPromptInput,
  SessionPushPayload,
  SlashCommand,
  ThinkingLevel,
  Thread,
} from "../shared/contracts.ts";
import {
  PROTOCOL_VERSION,
  previewFirstLines,
  THREAD_ASSISTANT_PREVIEW_MAX_CHARS,
  THREAD_USER_PREVIEW_MAX_CHARS,
} from "../shared/contracts.ts";
import type { ThreadWorkerBinding } from "../shared/sidecar-contracts.ts";
import { isThinkingLevel } from "../shared/thinking-levels.ts";
import { resolveDesktopSessionDirectory } from "./desktop-session-directory.ts";
import { assertSupportedPiVersion, type ProbedPi, resolveAndProbePi } from "./pi-resolver.ts";
import { PiRpcClient, type PiRpcHandshake, type PiRpcResponse } from "./pi-rpc-client.ts";

interface PiRpcSessionRuntimeOptions {
  binding: ThreadWorkerBinding;
  push(payload: SessionPushPayload): void;
  onSummaryChanged(current: PiRpcSessionRuntime): void;
  resolvePi?(environment: NodeJS.ProcessEnv): Promise<ProbedPi>;
}

interface RpcState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  model?: Record<string, unknown>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
}

const EMPTY_EXTENSION_HOST: SessionControlState["extensionHost"] = { statuses: {}, widgets: [] };
const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    name: "reload",
    description: "Reload Pi extensions, skills, prompts, and context files",
    source: "builtin",
    acceptsArguments: false,
  },
];
const MAX_EARLY_RPC_EVENTS = 1_024;

export class PiRpcSessionRuntime {
  readonly id: string;
  private readonly projectId: string;
  private readonly cwd: string;
  private readonly client: PiRpcClient;
  private readonly push: (payload: SessionPushPayload) => void;
  private readonly onSummaryChanged: (current: PiRpcSessionRuntime) => void;
  private state: RpcState;
  private context: ContextUsage | undefined;
  private models: ModelOption[];
  private commands: SlashCommand[];
  private thinkingLevels: ThinkingLevel[];
  private timeline: PiThreadSnapshot;
  private summary: Omit<Thread, "projectId" | "archived" | "running">;
  private revision = 0;
  private sequence = 0;
  private events: Array<{ sequence: number; event: PiRpcEvent }> = [];
  private lastError?: string;
  private retry?: SessionControlState["retry"];
  private queue: PiQueueItem[] = [];
  private hostRequests: HostRequest[] = [];
  private readonly hostRequestTimers = new Map<string, NodeJS.Timeout>();
  private extensionHost: SessionControlState["extensionHost"] = { ...EMPTY_EXTENSION_HOST };
  private extensionNotices: PiNoticeMessage[] = [];
  private refreshTail = Promise.resolve();
  private refreshActive = false;
  private refreshRequested = false;
  private disposed = false;

  private constructor(
    options: PiRpcSessionRuntimeOptions,
    client: PiRpcClient,
    handshake: PiRpcHandshake,
    state: RpcState,
    context: ContextUsage | undefined,
    thinkingLevels: ThinkingLevel[],
  ) {
    this.projectId = options.binding.projectId;
    this.cwd = options.binding.cwd;
    this.id = state.sessionId;
    this.client = client;
    this.push = options.push;
    this.onSummaryChanged = options.onSummaryChanged;
    this.state = state;
    this.context = context;
    this.models = parseModels(handshake.models);
    this.commands = [
      ...BUILTIN_COMMANDS,
      ...parseCommands(handshake.commands).filter((command) => command.name !== "reload"),
    ];
    this.thinkingLevels = thinkingLevels;
    this.timeline = this.createSnapshot(handshake.entries.entries, handshake.entries.leafId);
    this.summary = summarize(
      this.id,
      state.sessionName,
      this.timeline,
      options.binding.mode === "open" ? options.binding.initialUpdatedAt : undefined,
    );
  }

  static async create(options: PiRpcSessionRuntimeOptions): Promise<PiRpcSessionRuntime> {
    const binding = options.binding;
    const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: binding.agentDir };
    if (binding.shellPath) prependEnvironmentPath(environment, dirname(binding.shellPath));
    const pi = await (options.resolvePi ?? resolveAndProbePi)(environment);
    assertSupportedPiVersion(pi.version);
    const sessionDirectory = resolveDesktopSessionDirectory(binding.projectId, binding.agentDir);
    const piArgs = [
      ...(binding.mode === "create" ? ["--session-id", binding.sessionId] : ["--session", binding.sessionFile]),
      ...(sessionDirectory ? ["--session-dir", sessionDirectory] : []),
    ];
    const earlyEvents: PiRpcEvent[] = [];
    let runtime: PiRpcSessionRuntime | undefined;
    const { client, handshake } = await PiRpcClient.launch({
      pi,
      cwd: binding.cwd,
      environment,
      piArgs,
      onEvent: (event) => {
        if (runtime) runtime.handleEvent(event);
        else {
          if (earlyEvents.length >= MAX_EARLY_RPC_EVENTS) {
            throw new Error(`Pi emitted more than ${MAX_EARLY_RPC_EVENTS} events during startup`);
          }
          earlyEvents.push(event);
        }
      },
    });

    try {
      let state = parseState(handshake.state);
      if (binding.mode === "create") {
        if (state.sessionId !== binding.sessionId) {
          throw new Error(`Created Pi session ID mismatch: expected ${binding.sessionId}, got ${state.sessionId}`);
        }
        await client.request({
          type: "set_model",
          provider: binding.createInput.model.provider,
          modelId: binding.createInput.model.id,
        });
        await client.request({ type: "set_thinking_level", level: binding.createInput.thinkingLevel });
        state = await requestState(client);
      } else if (state.sessionId !== binding.threadId) {
        throw new Error(`Opened Pi session ID mismatch: expected ${binding.threadId}, got ${state.sessionId}`);
      }

      const [context, thinkingLevels] = await Promise.all([requestContextUsage(client), requestThinkingLevels(client)]);
      runtime = new PiRpcSessionRuntime(options, client, handshake, state, context, thinkingLevels);
      for (const event of earlyEvents) runtime.handleEvent(event);
      earlyEvents.length = 0;
      return runtime;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get sessionFile(): string | undefined {
    return this.state.sessionFile;
  }

  bootstrap(): SessionBootstrap {
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.id,
      timeline: this.timeline,
      events: [...this.events],
      control: this.control(),
    };
  }

  threadSummary(archived: boolean): Thread {
    return {
      ...this.summary,
      projectId: this.projectId,
      archived,
      running: this.timeline.phase !== "idle",
    };
  }

  async prompt(input: SessionPromptInput): Promise<SessionCommandResult> {
    this.assertIdentity(input.projectId, input.threadId);
    const wasStreaming = this.state.isStreaming;
    const quotes = input.quotes?.length ? input.quotes : input.quote ? [input.quote] : [];
    const message = withQuoteContext(input.text, quotes);
    try {
      if (this.summary.messageCount === 0 && input.text.trim()) {
        await this.rename(input.text.trim().slice(0, 48));
      }
      await this.client.request({
        type: "prompt",
        message,
        images: input.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
        ...(wasStreaming ? { streamingBehavior: input.desiredMode ?? "followUp" } : {}),
      });
      this.state = await requestState(this.client);
      this.setPhase(this.state.isCompacting ? "compacting" : this.state.isStreaming ? "running" : "idle");
      this.publishControl();
      return { accepted: true, queued: wasStreaming };
    } catch (error) {
      this.lastError = errorMessage(error);
      this.publishControl();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    await this.client.request({ type: "abort" });
  }

  async compact(): Promise<void> {
    await this.client.request({ type: "compact" }, null);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.client.request({ type: "set_model", provider, modelId });
    const [state, context, thinkingLevels] = await Promise.all([
      requestState(this.client),
      requestContextUsage(this.client),
      requestThinkingLevels(this.client),
    ]);
    this.state = state;
    this.context = context;
    this.thinkingLevels = thinkingLevels;
    this.publishControl();
  }

  async setThinking(level: ThinkingLevel): Promise<void> {
    await this.client.request({ type: "set_thinking_level", level });
    this.state = await requestState(this.client);
    this.publishControl();
  }

  async rename(title: string): Promise<void> {
    const normalized = title.trim();
    await this.client.request({ type: "set_session_name", name: normalized });
    this.state = { ...this.state, sessionName: normalized || undefined };
    this.summary = { ...this.summary, title: normalized || "新会话" };
    this.publishControl();
    this.onSummaryChanged(this);
  }

  async respond(response: HostResponse): Promise<void> {
    const request = this.hostRequests.find((item) => item.id === response.requestId);
    if (!request) throw new Error(`Pi extension UI request not found: ${response.requestId}`);
    this.hostRequests = this.hostRequests.filter((item) => item !== request);
    const timer = this.hostRequestTimers.get(response.requestId);
    if (timer) clearTimeout(timer);
    this.hostRequestTimers.delete(response.requestId);
    await this.client.send(
      response.dismissed
        ? { type: "extension_ui_response", id: response.requestId, cancelled: true }
        : request.type === "confirm"
          ? { type: "extension_ui_response", id: response.requestId, confirmed: response.confirmed === true }
          : { type: "extension_ui_response", id: response.requestId, value: response.value ?? "" },
    );
    this.publishControl();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.hostRequestTimers.values()) clearTimeout(timer);
    this.hostRequestTimers.clear();
    this.hostRequests = [];
    await this.client.close();
  }

  private handleEvent(event: PiRpcEvent): void {
    if (this.disposed) return;
    this.emitRpcEvent(event);
    switch (event.type) {
      case "agent_start":
        this.state = { ...this.state, isStreaming: true };
        this.setPhase("running");
        this.publishControl();
        return;
      case "agent_settled":
        this.state = { ...this.state, isStreaming: false, isCompacting: false };
        this.setPhase("idle");
        this.scheduleRefresh();
        return;
      case "message_end":
        return;
      case "entry_appended":
      case "session_info_changed":
        this.scheduleRefresh();
        return;
      case "thinking_level_changed":
        this.state = { ...this.state, thinkingLevel: parseThinkingLevel(event.level) };
        this.publishControl();
        return;
      case "compaction_start":
        this.state = { ...this.state, isCompacting: true };
        this.setPhase("compacting");
        return;
      case "compaction_end":
        this.state = { ...this.state, isCompacting: false };
        this.lastError = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
        this.setPhase(event.willRetry === true || this.state.isStreaming ? "running" : "idle");
        this.scheduleRefresh();
        return;
      case "auto_retry_start":
        if (typeof event.attempt === "number" && typeof event.maxAttempts === "number") {
          this.retry = {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            message: typeof event.errorMessage === "string" ? event.errorMessage : "Retrying",
          };
        }
        this.setPhase("retrying");
        this.publishControl();
        return;
      case "auto_retry_end":
        this.retry = undefined;
        this.lastError = typeof event.finalError === "string" ? event.finalError : undefined;
        this.publishControl();
        return;
      case "summarization_retry_scheduled":
        this.retry = {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          message: event.errorMessage,
        };
        this.setPhase("retrying");
        this.publishControl();
        return;
      case "summarization_retry_attempt_start":
        this.setPhase(event.source === "compaction" ? "compacting" : "tree-navigation");
        this.publishControl();
        return;
      case "summarization_retry_finished":
        this.retry = undefined;
        this.setPhase(this.state.isStreaming ? "running" : "idle");
        this.scheduleRefresh();
        return;
      case "queue_update":
        this.replaceQueue(event);
        return;
      case "extension_ui_request":
        this.handleExtensionUi(event);
        return;
      case "extension_error":
        this.handleExtensionError(event);
        return;
      default:
        return;
    }
  }

  private scheduleRefresh(): void {
    this.refreshRequested = true;
    if (this.refreshActive) return;
    this.refreshActive = true;
    this.refreshTail = this.refreshTail
      .then(async () => {
        while (this.refreshRequested && !this.disposed) {
          this.refreshRequested = false;
          const refreshSequence = this.sequence;
          const [entriesResponse, state, context] = await Promise.all([
            this.client.request({ type: "get_entries" }),
            requestState(this.client),
            requestContextUsage(this.client),
          ]);
          const data = responseRecord(entriesResponse);
          const entries = Array.isArray(data.entries) ? data.entries : undefined;
          const leafId = data.leafId;
          if (!entries || (leafId !== null && typeof leafId !== "string")) {
            throw new Error("get_entries response is malformed");
          }
          if (this.sequence !== refreshSequence || state.isStreaming) continue;
          this.state = state;
          this.context = context;
          this.replaceTimeline(entries, leafId, refreshSequence);
          this.lastError = undefined;
          this.publishControl();
        }
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.lastError = errorMessage(error);
        this.publishControl();
      })
      .finally(() => {
        this.refreshActive = false;
        if (this.refreshRequested && !this.disposed) this.scheduleRefresh();
      });
  }

  private replaceTimeline(entries: readonly SessionEntry[], leafId: string | null, cursor: number): void {
    const phase = this.timeline.phase;
    const projection = projectPersistedBranch(entries, leafId);
    const withNotices = this.appendExtensionNotices(projection.nodes, projection.headId);
    const snapshot: PiThreadSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.id,
      cursor,
      headId: withNotices.headId,
      nodes: withNotices.nodes,
      queue: this.queue,
      phase,
      thinkingLevel: this.state.thinkingLevel,
    };
    this.timeline = snapshot;
    this.events = this.events.filter(({ sequence }) => sequence > cursor);
    this.summary = summarize(this.id, this.state.sessionName, snapshot, undefined);
    this.onSummaryChanged(this);
  }

  private appendExtensionNotices(
    nodes: readonly PiTimelineNode[],
    headId: string | null,
  ): { nodes: readonly PiTimelineNode[]; headId: string | null } {
    let parentId = headId;
    this.extensionNotices = this.extensionNotices.map((notice) => {
      const linked = notice.parentId === parentId ? notice : { ...notice, parentId };
      parentId = linked.id;
      return linked;
    });
    return { nodes: [...nodes, ...this.extensionNotices], headId: parentId };
  }

  private createSnapshot(entries: readonly SessionEntry[], leafId: string | null): PiThreadSnapshot {
    const projection = projectPersistedBranch(entries, leafId);
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.id,
      cursor: this.sequence,
      headId: projection.headId,
      nodes: projection.nodes,
      queue: this.queue,
      phase: this.state.isCompacting ? "compacting" : this.state.isStreaming ? "running" : "idle",
      thinkingLevel: this.state.thinkingLevel,
    };
  }

  private setPhase(phase: PiThreadPhase): void {
    if (this.timeline.phase === phase) return;
    this.timeline = { ...this.timeline, phase };
  }

  private replaceQueue(event: Record<string, unknown>): void {
    const steering = stringArray(event.steering);
    const followUp = stringArray(event.followUp);
    this.queue = [
      ...steering.map(
        (prompt, index): PiQueueItem => ({
          id: `rpc:steer:${index}:${prompt}`,
          mode: "steer",
          prompt,
          source: "pi-observed",
        }),
      ),
      ...followUp.map(
        (prompt, index): PiQueueItem => ({
          id: `rpc:followUp:${index}:${prompt}`,
          mode: "followUp",
          prompt,
          source: "pi-observed",
        }),
      ),
    ];
    this.timeline = { ...this.timeline, queue: this.queue };
  }

  private handleExtensionUi(event: Record<string, unknown>): void {
    if (typeof event.id !== "string" || typeof event.method !== "string") return;
    if (
      event.method === "confirm" ||
      event.method === "select" ||
      event.method === "input" ||
      event.method === "editor"
    ) {
      const request: HostRequest = {
        id: event.id,
        type: event.method,
        title: typeof event.title === "string" ? event.title : "Pi",
        ...(typeof event.message === "string" ? { message: event.message } : {}),
        ...(typeof event.placeholder === "string" ? { placeholder: event.placeholder } : {}),
        ...(event.method === "editor" && typeof event.prefill === "string" ? { initialValue: event.prefill } : {}),
        ...(event.method === "select" ? { options: stringArray(event.options) } : {}),
        createdAt: Date.now(),
      };
      this.hostRequests = [...this.hostRequests.filter((item) => item.id !== request.id), request];
      const existingTimer = this.hostRequestTimers.get(request.id);
      if (existingTimer) clearTimeout(existingTimer);
      this.hostRequestTimers.delete(request.id);
      if (typeof event.timeout === "number" && event.timeout > 0) {
        const timer = setTimeout(() => {
          this.hostRequestTimers.delete(request.id);
          this.hostRequests = this.hostRequests.filter((item) => item.id !== request.id);
          this.publishControl();
        }, event.timeout);
        timer.unref();
        this.hostRequestTimers.set(request.id, timer);
      }
      this.publishControl();
      return;
    }
    if (event.method === "setStatus" && typeof event.statusKey === "string") {
      const statuses = { ...this.extensionHost.statuses };
      if (typeof event.statusText === "string") statuses[event.statusKey] = event.statusText;
      else delete statuses[event.statusKey];
      this.extensionHost = { ...this.extensionHost, statuses };
    } else if (event.method === "setWidget" && typeof event.widgetKey === "string") {
      const widgets = this.extensionHost.widgets.filter((widget) => widget.key !== event.widgetKey);
      if (Array.isArray(event.widgetLines)) {
        widgets.push({
          key: event.widgetKey,
          lines: stringArray(event.widgetLines),
          placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
        });
      }
      this.extensionHost = { ...this.extensionHost, widgets };
    } else if (event.method === "setTitle" && typeof event.title === "string") {
      this.extensionHost = { ...this.extensionHost, windowTitle: event.title };
    } else if (event.method === "set_editor_text" && typeof event.text === "string") {
      this.extensionHost = {
        ...this.extensionHost,
        composerCommand: {
          hostId: event.id,
          revision: Date.now(),
          mode: "replace",
          text: event.text,
        },
      };
    } else if (event.method === "notify" && typeof event.message === "string") {
      const notificationType =
        event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
      const notice: PiNoticeMessage = {
        id: `rpc-notify:${this.sequence}`,
        parentId: this.timeline.headId,
        createdAt: Date.now(),
        kind: "notice",
        noticeType: "notification",
        notificationType,
        title: "Pi 扩展通知",
        content: { type: "text", text: event.message },
      };
      this.extensionNotices = [...this.extensionNotices.slice(-99), notice];
      return;
    } else {
      return;
    }
    this.publishControl();
  }

  private handleExtensionError(event: Extract<PiRpcEvent, { type: "extension_error" }>): void {
    const notice: PiNoticeMessage = {
      id: `rpc-extension-error:${this.sequence}`,
      parentId: this.timeline.headId,
      createdAt: Date.now(),
      kind: "notice",
      noticeType: "notification",
      notificationType: "error",
      extensionNotification: {
        customType: "pi.extension_error",
        details: { extensionPath: event.extensionPath, event: event.event, error: event.error },
      },
      title: "Pi 扩展错误",
      content: { type: "text", text: event.error },
    };
    this.extensionNotices = [...this.extensionNotices.slice(-99), notice];
  }

  private emitRpcEvent(event: PiRpcEvent): void {
    this.sequence += 1;
    const sequenced = { sequence: this.sequence, event };
    this.events.push(sequenced);
    this.push({
      type: "timeline",
      projectId: this.projectId,
      threadId: this.id,
      sequence: this.sequence,
      event,
    });
  }

  private publishControl(): void {
    this.revision += 1;
    this.push({ type: "control", projectId: this.projectId, threadId: this.id, control: this.control() });
  }

  private control(): SessionControlState {
    const model = parseModel(this.state.model);
    const readiness: Readiness = model
      ? { state: "ready" }
      : this.models.length > 0
        ? { state: "missing-model", message: "Pi has no active model" }
        : { state: "missing-credentials", message: "Pi has no available authenticated models" };
    return {
      protocolVersion: PROTOCOL_VERSION,
      revision: this.revision,
      projectId: this.projectId,
      threadId: this.id,
      title: this.summary.title,
      updatedAt: this.summary.updatedAt,
      cwd: this.cwd,
      running: this.timeline.phase !== "idle",
      retry: this.retry,
      queueModes: { steering: this.state.steeringMode, followUp: this.state.followUpMode },
      model: model ? { provider: model.provider, id: model.id, name: model.name } : undefined,
      models: this.models,
      commands: this.commands,
      thinkingLevel: this.state.thinkingLevel,
      thinkingLevels: this.thinkingLevels,
      context: this.context,
      readiness,
      lastError: this.lastError,
      hostRequests: this.hostRequests,
      extensionHost: this.extensionHost,
    };
  }

  private assertIdentity(projectId: string, threadId: string): void {
    if (projectId !== this.projectId || threadId !== this.id) throw new Error("Pi RPC session identity mismatch");
  }
}

function prependEnvironmentPath(environment: NodeJS.ProcessEnv, directory: string): void {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path");
  const current = pathKey ? environment[pathKey] : undefined;
  if (pathKey && pathKey !== "PATH") delete environment[pathKey];
  environment.PATH = current ? `${directory}${delimiter}${current}` : directory;
}

function parseState(value: unknown): RpcState {
  const state = record(value, "get_state data");
  if (
    typeof state.sessionId !== "string" ||
    typeof state.thinkingLevel !== "string" ||
    typeof state.isStreaming !== "boolean" ||
    typeof state.isCompacting !== "boolean" ||
    (state.steeringMode !== "all" && state.steeringMode !== "one-at-a-time") ||
    (state.followUpMode !== "all" && state.followUpMode !== "one-at-a-time")
  ) {
    throw new Error("get_state response is missing required fields");
  }
  return {
    sessionId: state.sessionId,
    ...(typeof state.sessionFile === "string" ? { sessionFile: state.sessionFile } : {}),
    ...(typeof state.sessionName === "string" ? { sessionName: state.sessionName } : {}),
    ...(isRecord(state.model) ? { model: state.model } : {}),
    thinkingLevel: parseThinkingLevel(state.thinkingLevel),
    isStreaming: state.isStreaming,
    isCompacting: state.isCompacting,
    steeringMode: state.steeringMode,
    followUpMode: state.followUpMode,
  };
}

async function requestState(client: PiRpcClient): Promise<RpcState> {
  const response = await client.request({ type: "get_state" });
  return parseState(response.data);
}

async function requestContextUsage(client: PiRpcClient): Promise<ContextUsage | undefined> {
  const response = await client.request({ type: "get_session_stats" });
  const data = responseRecord(response);
  if (data.contextUsage === undefined) return undefined;
  const context = record(data.contextUsage, "get_session_stats contextUsage");
  if (
    (typeof context.tokens !== "number" && context.tokens !== null) ||
    typeof context.contextWindow !== "number" ||
    (typeof context.percent !== "number" && context.percent !== null)
  ) {
    throw new Error("get_session_stats response has malformed contextUsage");
  }
  return {
    tokens: context.tokens,
    contextWindow: context.contextWindow,
    percent: context.percent,
  };
}

async function requestThinkingLevels(client: PiRpcClient): Promise<ThinkingLevel[]> {
  const response = await client.request({ type: "get_available_thinking_levels" });
  return responseArray(response, "levels").map((level) => {
    if (typeof level !== "string") throw new Error("Thinking level must be a string");
    return parseThinkingLevel(level);
  });
}

function parseThinkingLevel(value: string): ThinkingLevel {
  if (isThinkingLevel(value)) return value;
  throw new Error(`Unsupported Pi thinking level: ${value}`);
}

function parseModels(values: readonly unknown[]): ModelOption[] {
  return values.flatMap((value) => {
    const model = parseModel(value);
    return model ? [model] : [];
  });
}

function parseModel(value: unknown): ModelOption | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.provider !== "string" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.contextWindow !== "number"
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    id: value.id,
    name: value.name,
    contextWindow: value.contextWindow,
    thinking: value.reasoning === true,
  };
}

function parseCommands(values: readonly unknown[]): SlashCommand[] {
  return values.flatMap((value) => {
    if (!isRecord(value) || typeof value.name !== "string") return [];
    if (value.source !== "extension" && value.source !== "prompt" && value.source !== "skill") return [];
    return [
      {
        name: value.name,
        ...(typeof value.description === "string" ? { description: value.description } : {}),
        source: value.source,
      },
    ];
  });
}

export function summarize(
  id: string,
  sessionName: string | undefined,
  timeline: PiThreadSnapshot,
  initialUpdatedAt: number | undefined,
): Omit<Thread, "projectId" | "archived" | "running"> {
  const visible = timeline.nodes.filter((node) => node.kind === "user" || node.kind === "assistant");
  const firstUser = visible.find((node) => node.kind === "user");
  const last = visible.at(-1);
  const lastUser = [...visible].reverse().find((node) => node.kind === "user");
  const preview = firstUser?.kind === "user" ? userText(firstUser.content).slice(0, 120) : "";
  return {
    id,
    title: sessionName?.trim() || preview.slice(0, 48) || "新会话",
    createdAt: visible[0]?.createdAt ?? Date.now(),
    updatedAt:
      initialUpdatedAt === undefined && last === undefined
        ? Date.now()
        : Math.max(initialUpdatedAt ?? 0, last?.createdAt ?? 0),
    messageCount: visible.length,
    preview,
    ...(lastUser?.kind === "user"
      ? { lastUserPreview: previewFirstLines(userText(lastUser.content), THREAD_USER_PREVIEW_MAX_CHARS) }
      : {}),
    lastAssistantPreview:
      last?.kind === "assistant"
        ? previewFirstLines(
            last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            THREAD_ASSISTANT_PREVIEW_MAX_CHARS,
          )
        : "",
  };
}

function userText(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

function responseArray(response: PiRpcResponse, field: string): unknown[] {
  const data = responseRecord(response);
  const value = data[field];
  if (!Array.isArray(value)) throw new Error(`${response.command} response field '${field}' must be an array`);
  return value;
}

function responseRecord(response: PiRpcResponse): Record<string, unknown> {
  if (!("data" in response)) throw new Error(`${response.command} response is missing data`);
  return record(response.data, `${response.command} response data`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
