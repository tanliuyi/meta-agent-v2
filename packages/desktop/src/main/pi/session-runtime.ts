import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  type ClearedQueue,
  PROTOCOL_VERSION,
  type SessionBootstrap,
  type SessionBranchInput,
  type SessionBranchResult,
  type SessionCommandResult,
  type SessionControlState,
  type SessionCreateInput,
  type SessionEditInput,
  type SessionPromptInput,
  type SessionPushPayload,
  type SessionReloadInput,
  type Thread,
} from "../../shared/contracts.ts";
import type { DesktopExtensionDiagnostic, ResolvedExtensionSet } from "../../shared/desktop-extension-contracts.ts";
import { DesktopBuiltinProviderRegistry } from "./desktop-builtin-provider.ts";
import { DesktopExtensionCompatibilityError, DesktopExtensionHost } from "./desktop-extension-host.ts";
import {
  controlledResourceLoaderOptions,
  extensionLoadDiagnostics,
  extensionServiceDiagnostics,
  sanitizeExtensionMessage,
} from "./desktop-extension-runtime-policy.ts";
import type { SubagentRuntime } from "./extensions/pi-subagents/src/runtime/subagent-runtime.ts";
import { PiCompatibilityAdapter } from "./pi-compatibility-adapter.ts";
import { PiThreadProjector } from "./pi-thread-projector.ts";
import { getSessionCommands } from "./session-commands.ts";
import {
  resolveSessionCreateSelection,
  resolveSessionResumeSelection,
  sessionReadiness,
} from "./session-configuration.ts";

interface RuntimeOptions {
  projectId: string;
  cwd: string;
  agentDir?: string;
  sessionManager?: SessionManager;
  createInput?: SessionCreateInput;
  extensionSet?: ResolvedExtensionSet;
  subagentRuntime?: SubagentRuntime;
  push(update: SessionPushPayload): void;
  onSummaryChanged(runtime: SessionRuntime): void;
}

/** 单个 Pi AgentSession 的生命周期、控制面与 Pi-native timeline。 */
export class SessionRuntime {
  private readonly extensionHost: DesktopExtensionHost;
  private readonly projector: PiThreadProjector;
  private readonly compatibility: PiCompatibilityAdapter;
  private readonly commands = new Map<string, Promise<SessionCommandResult>>();
  private readonly extensionSet: ResolvedExtensionSet;
  private extensionDiagnostics: DesktopExtensionDiagnostic[];
  private extensionPhase: DesktopExtensionDiagnostic["phase"] = "start";
  private readonly commandExpiryTimers = new Set<ReturnType<typeof setTimeout>>();
  private revision = 0;
  private retry?: SessionControlState["retry"];
  private lastError?: string;
  private timelineError?: PiTimelineUnavailableError;
  private unsubscribe?: () => void;
  private summaryState: Omit<Thread, "projectId" | "archived" | "running">;
  readonly projectId: string;
  readonly cwd: string;
  readonly session: AgentSession;
  private readonly models: ModelRegistry;
  private readonly push: (update: SessionPushPayload) => void;
  private readonly onSummaryChanged: (runtime: SessionRuntime) => void;
  private readonly subagentRuntime?: SubagentRuntime;

  private constructor(
    projectId: string,
    cwd: string,
    session: AgentSession,
    models: ModelRegistry,
    extensionSet: ResolvedExtensionSet,
    subagentRuntime: SubagentRuntime | undefined,
    push: (update: SessionPushPayload) => void,
    onSummaryChanged: (runtime: SessionRuntime) => void,
  ) {
    this.projectId = projectId;
    this.cwd = cwd;
    this.session = session;
    this.models = models;
    this.push = push;
    this.onSummaryChanged = onSummaryChanged;
    this.subagentRuntime = subagentRuntime;
    this.extensionSet = {
      ...extensionSet,
      entries: extensionSet.entries.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] })),
      diagnostics: extensionSet.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
    this.extensionDiagnostics = extensionSet.diagnostics.map((diagnostic) => ({ ...diagnostic }));
    this.projector = new PiThreadProjector({
      projectId,
      session,
      publish: (batch) => this.push({ type: "timeline", projectId, threadId: this.id, batch }),
    });
    this.extensionHost = new DesktopExtensionHost(
      () => this.publishControl(),
      () => [...this.session.state.pendingToolCalls],
      (message, type) => this.projector.notify(message, type),
    );
    this.compatibility = new PiCompatibilityAdapter({ session, projector: this.projector });
    this.summaryState = createSummary(session);
  }

  /** 创建新会话或从指定 SessionManager 恢复会话。 */
  static async create(options: RuntimeOptions): Promise<SessionRuntime> {
    const extensionSet = options.extensionSet ?? builtinOnlyExtensionSet(options.projectId);
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      resourceLoaderOptions: controlledResourceLoaderOptions(
        extensionSet,
        DesktopBuiltinProviderRegistry.getExtensionFactories({ subagentRuntime: options.subagentRuntime }),
      ),
    });
    const extensionDiagnostics = [
      ...extensionLoadDiagnostics(extensionSet, services.resourceLoader.getExtensions()),
      ...extensionServiceDiagnostics(extensionSet, services.diagnostics),
    ];
    if (extensionDiagnostics.length > 0) {
      throw new DesktopExtensionStartupError(extensionSet.generation, extensionDiagnostics);
    }
    const sessionManager = options.sessionManager ?? SessionManager.create(services.cwd);
    const selection = options.createInput
      ? resolveSessionCreateSelection(options.createInput, services.modelRegistry)
      : options.sessionManager
        ? resolveSessionResumeSelection(options.sessionManager, services.modelRegistry)
        : undefined;
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(selection ? { model: selection.model, thinkingLevel: selection.thinkingLevel } : {}),
      sessionStartEvent: { type: "session_start", reason: options.sessionManager ? "resume" : "new" },
    });
    let runtime: SessionRuntime;
    try {
      runtime = new SessionRuntime(
        options.projectId,
        options.cwd,
        result.session,
        services.modelRegistry,
        extensionSet,
        options.subagentRuntime,
        options.push,
        options.onSummaryChanged,
      );
      runtime.extensionDiagnostics = extensionDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        projectId: options.projectId,
        threadId: runtime.id,
      }));
    } catch (error) {
      result.session.dispose();
      throw new PiTimelineUnavailableError("initial projection", error);
    }
    runtime.lastError = joinRuntimeDiagnostics(
      result.modelFallbackMessage,
      services.diagnostics.map(({ message }) => message),
      runtime.extensionDiagnostics.map(({ extensionId, message }) => `扩展加载失败 ${extensionId}: ${message}`),
      services.resourceLoader
        .getSkills()
        .diagnostics.filter(({ type }) => type === "error")
        .map(({ path, message }) => `Skill 加载失败${path ? ` ${path}` : ""}: ${message}`),
    );
    const unavailableCommand = async (capability: string): Promise<never> => {
      throw new DesktopExtensionCompatibilityError("DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE", capability);
    };
    let bindingFailure: unknown;
    try {
      await result.session.bindExtensions({
        uiContext: runtime.extensionHost.createContext(),
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => runtime.session.waitForIdle(),
          newSession: () => unavailableCommand("session.replace"),
          fork: () => unavailableCommand("session.replace"),
          navigateTree: () => unavailableCommand("session.replace"),
          switchSession: () => unavailableCommand("session.replace"),
          reload: () => unavailableCommand("session.reload"),
        },
        onError: (error) => {
          const entry = runtime.extensionSet.entries.find(
            (candidate) =>
              candidate.entryPath === error.extensionPath ||
              error.extensionPath.includes(candidate.id) ||
              error.extensionPath.includes(candidate.displayName),
          );
          const message = sanitizeExtensionMessage(error.error, error.extensionPath, entry?.displayName ?? entry?.id);
          runtime.extensionDiagnostics = [
            ...runtime.extensionDiagnostics,
            {
              extensionId: entry?.id ?? "unknown",
              source: entry?.source ?? "development",
              extensionSetGeneration: runtime.extensionSet.generation,
              projectId: runtime.projectId,
              threadId: runtime.id,
              phase: runtime.extensionPhase,
              code:
                runtime.extensionPhase === "start"
                  ? "DESKTOP_EXTENSION_START_FAILED"
                  : runtime.extensionPhase === "dispose"
                    ? "DESKTOP_EXTENSION_DISPOSE_FAILED"
                    : "DESKTOP_EXTENSION_RUNTIME_ERROR",
              message,
            },
          ];
          runtime.lastError = `${entry?.id ?? "unknown"}: ${message}`;
          if (runtime.extensionPhase === "runtime") runtime.publishControl();
        },
      });
    } catch (error) {
      bindingFailure = error;
      runtime.extensionDiagnostics = [
        ...runtime.extensionDiagnostics,
        {
          extensionId: "unknown",
          source: "builtin",
          extensionSetGeneration: runtime.extensionSet.generation,
          projectId: runtime.projectId,
          threadId: runtime.id,
          phase: "start",
          code: "DESKTOP_EXTENSION_START_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ];
    } finally {
      runtime.extensionPhase = "runtime";
    }
    const startupDiagnostics = runtime.extensionDiagnostics.filter(({ phase }) => phase === "start");
    if (bindingFailure || startupDiagnostics.length > 0) {
      runtime.extensionHost.dispose();
      result.session.dispose();
      throw new DesktopExtensionStartupError(extensionSet.generation, startupDiagnostics);
    }
    runtime.projector.checkpoint();
    runtime.unsubscribe = result.session.subscribe((event) => runtime.onEvent(event));
    return runtime;
  }

  get id(): string {
    return this.session.sessionId;
  }

  get file(): string | undefined {
    return this.session.sessionFile;
  }

  /** attach 或 sequence resync 时直接返回完整 Pi snapshot。 */
  bootstrap(): SessionBootstrap {
    this.assertTimelineAvailable();
    try {
      this.compatibility.synchronizePersistedBranch();
    } catch (error) {
      this.timelineError = new PiTimelineUnavailableError("bootstrap checkpoint", error);
      this.lastError = this.timelineError.message;
      this.publishControl();
      throw this.timelineError;
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.id,
      timeline: this.projector.snapshot(),
      control: this.control(),
    };
  }

  /** 列表页使用的 O(1) 运行时摘要。 */
  threadSummary(archived: boolean): Thread {
    return {
      ...this.summaryState,
      projectId: this.projectId,
      archived,
      running: this.projector.snapshot().phase !== "idle",
    };
  }

  prompt(input: SessionPromptInput): Promise<SessionCommandResult> {
    this.assertTimelineAvailable();
    if (input.threadId !== this.id || input.projectId !== this.projectId) throw new Error("Pi prompt session 不匹配");
    this.updateTitleFromPrompt(input.text);
    return this.runCommand(input.requestId, () => this.compatibility.prompt(input));
  }

  edit(input: SessionEditInput): Promise<SessionCommandResult> {
    this.assertTimelineAvailable();
    if (input.threadId !== this.id || input.projectId !== this.projectId) throw new Error("Pi edit session 不匹配");
    return this.runCommand(input.requestId, () => this.compatibility.edit(input));
  }

  reload(input: SessionReloadInput): Promise<SessionCommandResult> {
    this.assertTimelineAvailable();
    if (input.threadId !== this.id || input.projectId !== this.projectId) throw new Error("Pi reload session 不匹配");
    return this.runCommand(input.requestId, () => this.compatibility.reload(input));
  }

  /** 在指定 entry 处 fork 当前 session 为新 session 文件，返回新会话 id + 文件路径。 */
  async branch(input: SessionBranchInput): Promise<SessionBranchResult> {
    this.assertTimelineAvailable();
    if (input.threadId !== this.id || input.projectId !== this.projectId) throw new Error("Pi branch session 不匹配");
    this.lastError = undefined;
    try {
      return await this.compatibility.branch(input);
    } catch (error: unknown) {
      this.lastError = errorMessage(error);
      this.publishControl();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    await this.compatibility.cancel();
  }

  clearQueue(): ClearedQueue {
    return this.compatibility.clearQueue();
  }

  async compact(): Promise<void> {
    await this.compatibility.compact();
  }

  refreshModels(): void {
    this.models.authStorage.reload();
    this.models.refresh();
    this.publishControl();
    const error = this.models.getError();
    if (error) throw new Error(error);
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

  respond(response: Parameters<DesktopExtensionHost["respond"]>[0]): void {
    this.extensionHost.respond(response);
  }

  async dispose(): Promise<void> {
    if (this.projector.snapshot().phase !== "idle") {
      try {
        await this.compatibility.cancel();
      } catch {
        // Session disposal below remains authoritative when an operation settled concurrently.
      }
    }
    this.extensionPhase = "dispose";
    if (this.session.extensionRunner.hasHandlers("session_shutdown")) {
      try {
        await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } catch (error) {
        this.lastError = `Extension shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.unsubscribe?.();
    this.projector.dispose();
    this.extensionHost.dispose();
    for (const timer of this.commandExpiryTimers) clearTimeout(timer);
    this.commandExpiryTimers.clear();
    this.commands.clear();
    this.session.dispose();
    await this.subagentRuntime?.dispose();
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
      updatedAt: this.summaryState.updatedAt,
      cwd: this.cwd,
      running: this.projector.snapshot().phase !== "idle",
      retry: this.retry,
      queueModes: { steering: this.session.steeringMode, followUp: this.session.followUpMode },
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
      hostRequests: this.extensionHost.requests,
      extensionSet: {
        generation: this.extensionSet.generation,
        diagnostics: this.extensionDiagnostics,
        reloadRequired: false,
      },
      extensionHost: this.extensionHost.hostState,
    };
  }

  private onEvent(event: AgentSessionEvent): void {
    if (!this.timelineError) {
      try {
        this.projector.handle(event);
      } catch (error) {
        this.lastError = errorMessage(error);
        try {
          this.projector.resync();
        } catch (rebuildError) {
          this.timelineError = new PiTimelineUnavailableError(error, rebuildError);
          this.lastError = this.timelineError.message;
        }
      }
    }

    let publish = false;
    if (event.type === "compaction_end") {
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
      event.type === "thinking_level_changed" ||
      event.type === "compaction_start"
    ) {
      publish = true;
    }

    if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant")) {
      this.updateSummary(event.message);
      this.onSummaryChanged(this);
      publish = true;
    }
    if (event.type === "session_info_changed") {
      this.summaryState = { ...this.summaryState, title: event.name?.trim() || this.summaryState.title };
      this.onSummaryChanged(this);
      publish = true;
    }
    if (event.type === "agent_settled") this.onSummaryChanged(this);
    if (this.timelineError) this.lastError = this.timelineError.message;
    if (publish || this.lastError) this.publishControl();
  }

  private assertTimelineAvailable(): void {
    if (this.timelineError) throw this.timelineError;
  }

  private publishControl(): void {
    this.revision += 1;
    this.push({ type: "control", projectId: this.projectId, threadId: this.id, control: this.control() });
  }

  private runCommand(requestId: string, command: () => Promise<SessionCommandResult>): Promise<SessionCommandResult> {
    const existing = this.commands.get(requestId);
    if (existing) return existing;
    this.lastError = undefined;
    const promise = command()
      .then((result) => {
        this.lastError = result.error;
        if (result.error) this.publishControl();
        return result;
      })
      .catch((error: unknown) => {
        this.lastError = errorMessage(error);
        this.publishControl();
        throw error;
      });
    this.commands.set(requestId, promise);
    const timer = setTimeout(() => {
      this.commands.delete(requestId);
      this.commandExpiryTimers.delete(timer);
    }, 60_000);
    this.commandExpiryTimers.add(timer);
    return promise;
  }

  private updateTitleFromPrompt(text: string): void {
    if (this.session.sessionName || this.summaryState.preview) return;
    const title = text.slice(0, 48) || "新会话";
    if (title === this.summaryState.title) return;
    this.summaryState = { ...this.summaryState, title };
    this.onSummaryChanged(this);
    this.publishControl();
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

export class DesktopExtensionStartupError extends Error {
  readonly code = "DESKTOP_EXTENSION_STARTUP_FAILED";
  readonly details: { generation: string; diagnostics: DesktopExtensionDiagnostic[] };

  constructor(generation: string, diagnostics: DesktopExtensionDiagnostic[]) {
    super(
      `Desktop extension startup failed for generation ${generation}: ${diagnostics
        .map(({ extensionId, code }) => `${extensionId} (${code})`)
        .join(", ")}`,
    );
    this.name = "DesktopExtensionStartupError";
    this.details = { generation, diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  }
}

export class PiTimelineUnavailableError extends Error {
  constructor(projectionError: unknown, rebuildError: unknown) {
    super(`Pi timeline 不可用: ${errorMessage(projectionError)}; rebuild 失败: ${errorMessage(rebuildError)}`);
    this.name = "PiTimelineUnavailableError";
  }
}

function builtinOnlyExtensionSet(projectId: string): ResolvedExtensionSet {
  return {
    generation: "desktop-builtins-only",
    projectId,
    entries: DesktopBuiltinProviderRegistry.getExtensionDefinitions().map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities],
    })),
    diagnostics: [],
    resolvedAt: 0,
  };
}

function createSummary(session: AgentSession): Omit<Thread, "projectId" | "archived" | "running"> {
  const visible = session.messages.filter((message) => message.role === "user" || message.role === "assistant");
  const first = visible.find((message) => message.role === "user");
  const preview = first?.role === "user" ? contentText(first.content).slice(0, 120) : "";
  const headerTimestamp = Date.parse(session.sessionManager.getHeader()?.timestamp ?? "");
  const lastMessageTimestamp = visible.at(-1)?.timestamp ?? 0;
  const updatedAt =
    Math.max(lastMessageTimestamp, Number.isFinite(headerTimestamp) ? headerTimestamp : 0) || Date.now();
  return {
    id: session.sessionId,
    title: session.sessionName || preview.slice(0, 48) || "新会话",
    createdAt: visible[0]?.timestamp ?? Date.now(),
    updatedAt,
    messageCount: visible.length,
    preview,
  };
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

function joinRuntimeDiagnostics(primary: string | undefined, ...groups: string[][]): string | undefined {
  const messages = [primary, ...groups.flat()].filter((message): message is string => Boolean(message));
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
