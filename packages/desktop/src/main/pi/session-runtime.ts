import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type ClearedQueue,
  PROTOCOL_VERSION,
  previewFirstLines,
  type SessionBootstrap,
  type SessionBranchInput,
  type SessionBranchResult,
  type SessionCommandResult,
  type SessionControlState,
  type SessionCreateInput,
  type SessionEditInput,
  type SessionImageResource,
  type SessionPromptInput,
  type SessionPushPayload,
  type SessionReloadInput,
  THREAD_ASSISTANT_PREVIEW_MAX_CHARS,
  THREAD_USER_PREVIEW_MAX_CHARS,
  type Thread,
} from "../../shared/contracts.ts";
import type { DesktopExtensionDiagnostic, ResolvedExtensionSet } from "../../shared/desktop-extension-contracts.ts";
import type { SessionCheckpointDiffResult, SessionCheckpointRestoreResult } from "../../shared/pi-rewind-contracts.ts";
import { FileCredentialStore } from "../models/credential-store.ts";
import { DesktopBuiltinProviderRegistry } from "./desktop-builtin-provider.ts";
import { DesktopExtensionCompatibilityError, DesktopExtensionHost } from "./desktop-extension-host.ts";
import {
  controlledResourceLoaderOptions,
  extensionLoadDiagnostics,
  extensionServiceDiagnostics,
  isBlockingExtensionDiagnostic,
  sanitizeExtensionMessage,
  validatePluginSkills,
} from "./desktop-extension-runtime-policy.ts";
import { getDesktopCheckpointDiff, restoreDesktopCheckpoint } from "./extensions/pi-rewind/src/index.ts";
import type { SubagentRuntime } from "./extensions/pi-subagents/src/runtime/subagent-runtime.ts";
import { PiCompatibilityAdapter } from "./pi-compatibility-adapter.ts";
import { PiThreadProjector } from "./pi-thread-projector.ts";
import { PluginCallRegistryHolder } from "./plugin-call/plugin-call-tool.ts";
import { DesktopPluginRegistryBuilder } from "./plugin-call/plugin-method-registry.ts";
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
  shellPath?: string;
  sessionManager?: SessionManager;
  initialUpdatedAt?: number;
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
  private extensionSet: ResolvedExtensionSet;
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
  private readonly models: ModelRuntime;
  private readonly push: (update: SessionPushPayload) => void;
  private readonly onSummaryChanged: (runtime: SessionRuntime) => void;
  private readonly subagentRuntime?: SubagentRuntime;
  private readonly pluginCallRegistry: PluginCallRegistryHolder;

  private constructor(
    projectId: string,
    cwd: string,
    session: AgentSession,
    models: ModelRuntime,
    extensionSet: ResolvedExtensionSet,
    initialUpdatedAt: number | undefined,
    subagentRuntime: SubagentRuntime | undefined,
    pluginCallRegistry: PluginCallRegistryHolder,
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
    this.pluginCallRegistry = pluginCallRegistry;
    this.extensionSet = {
      ...extensionSet,
      entries: extensionSet.entries.map((entry) => ({
        ...entry,
        capabilities: [...entry.capabilities],
        ...(entry.configuration ? { configuration: { ...entry.configuration } } : {}),
      })),
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
      (message, type, options) => this.projector.notify(message, type, options),
      (message) => this.recordCapabilityDegradation(message),
    );
    this.compatibility = new PiCompatibilityAdapter({ session, projector: this.projector });
    this.summaryState = createSummary(session, initialUpdatedAt);
  }

  /** 创建新会话或从指定 SessionManager 恢复会话。 */
  static async create(options: RuntimeOptions): Promise<SessionRuntime> {
    const extensionSet = options.extensionSet ?? builtinOnlyExtensionSet(options.projectId);
    const agentDir = options.agentDir ?? getAgentDir();
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    if (options.shellPath) {
      const settingsWithDefaults = settingsManager as unknown as {
        applyDefaults?: (values: { shellPath: string }) => void;
        applyOverrides?: (values: { shellPath: string }) => void;
      };
      if (settingsWithDefaults.applyDefaults) settingsWithDefaults.applyDefaults({ shellPath: options.shellPath });
      else settingsWithDefaults.applyOverrides?.({ shellPath: options.shellPath });
    }
    const modelRuntime = await ModelRuntime.create({
      credentials: new FileCredentialStore(join(agentDir, "auth.json")),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const builder = new DesktopPluginRegistryBuilder();
    const registryHolder = new PluginCallRegistryHolder(extensionSet.generation);
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: controlledResourceLoaderOptions(
        extensionSet,
        DesktopBuiltinProviderRegistry.getExtensionFactories({ subagentRuntime: options.subagentRuntime }),
        { pluginRegistry: registryHolder, pluginRegistryBuilder: builder, cwd: options.cwd },
      ),
    });
    const extensionDiagnostics = [
      ...extensionLoadDiagnostics(extensionSet, services.resourceLoader.getExtensions()),
      ...extensionServiceDiagnostics(extensionSet, services.diagnostics),
      ...validatePluginSkills(extensionSet, services.resourceLoader.getSkills()),
    ];
    const blockingExtensionDiagnostics = extensionDiagnostics.filter(isBlockingExtensionDiagnostic);
    if (blockingExtensionDiagnostics.length > 0) {
      builder.discard();
      throw new DesktopExtensionStartupError(extensionSet.generation, blockingExtensionDiagnostics);
    }
    try {
      registryHolder.bind(builder.finalize(), options.cwd);
    } catch (error) {
      builder.discard();
      throw new DesktopExtensionStartupError(extensionSet.generation, [
        {
          extensionId: "unknown",
          source: "builtin",
          extensionSetGeneration: extensionSet.generation,
          projectId: options.projectId,
          phase: "register",
          code: "DESKTOP_PLUGIN_ADMISSION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
    const sessionManager = options.sessionManager ?? SessionManager.create(services.cwd);
    const isNewSession = options.createInput !== undefined || options.sessionManager === undefined;
    const selection = options.createInput
      ? resolveSessionCreateSelection(options.createInput, services.modelRuntime)
      : options.sessionManager
        ? resolveSessionResumeSelection(options.sessionManager, services.modelRuntime)
        : undefined;
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(selection ? { model: selection.model, thinkingLevel: selection.thinkingLevel } : {}),
      sessionStartEvent: { type: "session_start", reason: isNewSession ? "new" : "resume" },
    });
    let runtime: SessionRuntime;
    try {
      runtime = new SessionRuntime(
        options.projectId,
        options.cwd,
        result.session,
        services.modelRuntime,
        extensionSet,
        options.initialUpdatedAt,
        options.subagentRuntime,
        registryHolder,
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
      runtime.extensionDiagnostics.flatMap(({ extensionId, message, ...diagnostic }) =>
        isBlockingExtensionDiagnostic(diagnostic) ? [`扩展加载失败 ${extensionId}: ${message}`] : [],
      ),
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
    const startupDiagnostics = runtime.extensionDiagnostics.filter(
      (diagnostic) => diagnostic.phase === "start" && isBlockingExtensionDiagnostic(diagnostic),
    );
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

  /** 读取 timeline 引用的图像资源主体（worker 生命周期内有效）。 */
  readImageResource(resourceId: string): SessionImageResource | undefined {
    return this.projector.readImageResource(resourceId);
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

  getCheckpointDiff(
    fromCheckpointId: string,
    toCheckpointId: string,
    path: string,
  ): Promise<SessionCheckpointDiffResult> {
    this.assertTimelineAvailable();
    return getDesktopCheckpointDiff(this.cwd, this.id, fromCheckpointId, toCheckpointId, path);
  }

  async restoreCheckpoint(checkpointId: string, expectedCheckpointId: string): Promise<SessionCheckpointRestoreResult> {
    this.assertTimelineAvailable();
    const phase = this.projector.snapshot().phase;
    if (phase !== "idle") throw new Error(`Pi ${phase} 阶段不支持撤销 checkpoint`);
    this.lastError = undefined;
    try {
      const result = await restoreDesktopCheckpoint(this.cwd, this.id, checkpointId, expectedCheckpointId);
      this.publishControl();
      return result;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.publishControl();
      throw error;
    }
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

  async cancel(): Promise<ClearedQueue> {
    return this.compatibility.cancel();
  }

  clearQueue(): ClearedQueue {
    return this.compatibility.clearQueue();
  }

  async compact(): Promise<void> {
    await this.compatibility.compact();
  }

  resolvePluginCallArtifact(toolCallId: string, artifactId: string): Promise<string | undefined> {
    return this.projector.resolvePluginCallArtifact(toolCallId, artifactId);
  }

  async reloadResources(): Promise<SessionCommandResult> {
    this.assertTimelineAvailable();
    const phase = this.projector.snapshot().phase;
    if (phase !== "idle") {
      return { accepted: false, queued: false, error: `Pi ${phase} 阶段不支持资源重新加载` };
    }

    this.extensionDiagnostics = [];
    this.extensionPhase = "start";
    this.lastError = undefined;
    this.extensionHost.reset();
    try {
      await this.session.reload();
      const lifecycleDiagnostics = this.extensionDiagnostics;
      this.extensionDiagnostics = [
        ...extensionLoadDiagnostics(this.extensionSet, this.session.resourceLoader.getExtensions()).map(
          (diagnostic) => ({ ...diagnostic, threadId: this.id }),
        ),
        ...lifecycleDiagnostics,
      ];
      this.lastError = joinRuntimeDiagnostics(
        undefined,
        this.extensionDiagnostics.flatMap(({ extensionId, message, ...diagnostic }) =>
          isBlockingExtensionDiagnostic(diagnostic) ? [`扩展加载失败 ${extensionId}: ${message}`] : [],
        ),
        resourceErrorMessages("Skill", this.session.resourceLoader.getSkills().diagnostics),
        resourceErrorMessages("Prompt", this.session.resourceLoader.getPrompts().diagnostics),
      );
      return this.lastError
        ? { accepted: false, queued: false, error: this.lastError }
        : { accepted: true, queued: false };
    } catch (error) {
      this.lastError = errorMessage(error);
      return { accepted: false, queued: false, error: this.lastError };
    } finally {
      this.extensionPhase = "runtime";
      this.publishControl();
    }
  }

  async refreshModels(): Promise<void> {
    await this.models.refresh({ allowNetwork: false });
    const error = this.models.getError();
    if (error) throw new Error(error);

    const currentModel = this.session.model;
    if (currentModel) {
      const refreshedModel = this.models.getModel(currentModel.provider, currentModel.id);
      if (
        refreshedModel &&
        isModelMateriallyDifferent(currentModel, refreshedModel) &&
        this.models.hasConfiguredAuth(currentModel.provider)
      ) {
        await this.session.setModel(refreshedModel);
      }
    }
    this.publishControl();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.models.getModel(provider, modelId);
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
    await this.pluginCallRegistry.dispose();
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
    const available = this.models.getAvailableSnapshot();
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
      readiness: sessionReadiness(Boolean(model), available.length, this.models.getModels().length),
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
      event.type === "compaction_start" ||
      event.type === "summarization_retry_scheduled" ||
      event.type === "summarization_retry_attempt_start" ||
      event.type === "summarization_retry_finished"
    ) {
      publish = true;
    }

    if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant")) {
      this.updateSummary(event.message);
      this.onSummaryChanged(this);
      publish = true;
    }
    if (event.type === "session_info_changed") {
      const title = event.name?.trim() || this.summaryState.preview.slice(0, 48) || "新会话";
      this.summaryState = { ...this.summaryState, title };
      this.onSummaryChanged(this);
      publish = true;
    }
    if (event.type === "agent_settled") {
      this.summaryState = {
        ...this.summaryState,
        updatedAt: Math.max(this.summaryState.updatedAt, Date.now()),
      };
      this.onSummaryChanged(this);
    }
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

  /** Records an unsupported-capability degradation as a runtime diagnostic (deduplicated). */
  private recordCapabilityDegradation(message: string): void {
    const diagnostic: DesktopExtensionDiagnostic = {
      extensionId: "unknown",
      source: "development",
      extensionSetGeneration: this.extensionSet.generation,
      projectId: this.projectId,
      threadId: this.id,
      phase: "runtime",
      code: "DESKTOP_EXTENSION_CAPABILITY_DEGRADED",
      message,
    };
    const last = this.extensionDiagnostics[this.extensionDiagnostics.length - 1];
    if (last?.code === diagnostic.code && last.message === diagnostic.message) return;
    this.extensionDiagnostics = [...this.extensionDiagnostics, diagnostic];
    this.publishControl();
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
      ...(message.role === "user" || message.role === "assistant"
        ? {
            lastUserPreview:
              message.role === "user"
                ? previewFirstLines(contentText(message.content), THREAD_USER_PREVIEW_MAX_CHARS)
                : this.summaryState.lastUserPreview,
            lastAssistantPreview:
              message.role === "assistant"
                ? previewFirstLines(contentText(message.content), THREAD_ASSISTANT_PREVIEW_MAX_CHARS)
                : "",
          }
        : {}),
      updatedAt:
        message.role === "user"
          ? Math.max(this.summaryState.updatedAt, message.timestamp)
          : this.summaryState.updatedAt,
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

function createSummary(
  session: AgentSession,
  initialUpdatedAt?: number,
): Omit<Thread, "projectId" | "archived" | "running"> {
  const visible = session.messages.filter((message) => message.role === "user" || message.role === "assistant");
  const first = visible.find((message) => message.role === "user");
  const last = visible.at(-1);
  const lastUser = last ? [...visible].reverse().find((message) => message.role === "user") : undefined;
  const preview = first?.role === "user" ? contentText(first.content).slice(0, 120) : "";
  const lastUserPreview = lastUser
    ? previewFirstLines(contentText(lastUser.content), THREAD_USER_PREVIEW_MAX_CHARS)
    : undefined;
  const lastAssistantPreview =
    last?.role === "assistant" ? previewFirstLines(contentText(last.content), THREAD_ASSISTANT_PREVIEW_MAX_CHARS) : "";
  const headerTimestamp = Date.parse(session.sessionManager.getHeader()?.timestamp ?? "");
  const lastMessageTimestamp = last?.timestamp ?? 0;
  const updatedAt =
    initialUpdatedAt ??
    (Math.max(lastMessageTimestamp, Number.isFinite(headerTimestamp) ? headerTimestamp : 0) || Date.now());
  return {
    id: session.sessionId,
    title: session.sessionName || preview.slice(0, 48) || "新会话",
    createdAt: visible[0]?.timestamp ?? Date.now(),
    updatedAt,
    messageCount: visible.length,
    preview,
    ...(lastUserPreview !== undefined ? { lastUserPreview } : {}),
    lastAssistantPreview,
  };
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

function resourceErrorMessages(
  label: string,
  diagnostics: Array<{ type: string; message: string; path?: string }>,
): string[] {
  return diagnostics.flatMap((diagnostic) =>
    diagnostic.type === "error"
      ? [`${label} 加载失败${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}`]
      : [],
  );
}

function joinRuntimeDiagnostics(primary: string | undefined, ...groups: string[][]): string | undefined {
  const messages = [primary, ...groups.flat()].filter((message): message is string => Boolean(message));
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Returns true when two Model instances differ in fields that affect the
 * session (endpoint, config, capabilities, compat overrides, headers,
 * thinking-level map).  Uses deep equality so changes in any of these
 * properties trigger a session model update.
 */
function isModelMateriallyDifferent(current: Model<Api>, candidate: Model<Api>): boolean {
  if (current.provider !== candidate.provider || current.id !== candidate.id) return false;
  return !isDeepStrictEqual(current, candidate);
}
