import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "../main/models/credential-store.ts";
import { DesktopBuiltinProviderRegistry } from "../main/pi/desktop-builtin-provider.ts";
import { DesktopExtensionHost } from "../main/pi/desktop-extension-host.ts";
import { controlledResourceLoaderOptions } from "../main/pi/desktop-extension-runtime-policy.ts";
import registerFanoutChildSubagentExtension from "../main/pi/extensions/pi-subagents/src/extension/fanout-child.ts";
import {
  ensureSupervisorChannelDir,
  registerNativeSupervisorClient,
  resolveSupervisorChannelDir,
} from "../main/pi/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_ORCHESTRATOR_TARGET_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../main/pi/extensions/pi-subagents/src/runs/shared/env-constants.ts";
import {
  createStructuredOutputToolParameters,
  validateStructuredOutputValue,
} from "../main/pi/extensions/pi-subagents/src/runs/shared/structured-output.ts";
import {
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
} from "../main/pi/extensions/pi-subagents/src/runs/shared/tool-budget.ts";
import { PiThreadProjector } from "../main/pi/pi-thread-projector.ts";
import { DesktopSubagentRuntime } from "../main/pi/subagents/desktop-subagent-runtime.ts";
import { PROTOCOL_VERSION, type SessionBootstrap, type SessionControlState } from "../shared/contracts.ts";
import type { SidecarBinding, SidecarCommand } from "../shared/sidecar-contracts.ts";
import { toJsonValue } from "../shared/sidecar-wire.ts";
import {
  SUBAGENT_TIMEOUT_CODE,
  type SubagentChildExtension,
  type SubagentRunRequest,
  type SubagentWorkerBinding,
  type SubagentWorkerCommand,
} from "../shared/subagent-contracts.ts";
import type { SidecarService, SidecarServiceContext } from "./sidecar-host.ts";

const CHILD_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent, not the parent orchestrator.",
  "Complete only the assigned role-specific task with the tools available to you.",
  "Do not launch or propose additional subagents unless this worker explicitly grants fanout capability.",
].join("\n");

export interface SubagentWorkerServiceDependencies {
  extensionFactories?: InlineExtension[];
}

export class SubagentWorkerService implements SidecarService {
  private readonly binding: SubagentWorkerBinding;
  private readonly context: SidecarServiceContext;
  private readonly dependencies: SubagentWorkerServiceDependencies;
  private session?: AgentSession;
  private modelRuntime?: ModelRuntime;
  private modelConfigurationGeneration = 0;
  private extensionHost?: DesktopExtensionHost;
  private projector?: PiThreadProjector;
  private controlState?: SessionControlState;
  private runStarted = false;
  private initialPromptObserved = false;
  private runSettled = false;
  private cancelled = false;
  private disposed = false;

  private constructor(
    binding: SubagentWorkerBinding,
    context: SidecarServiceContext,
    dependencies: SubagentWorkerServiceDependencies,
  ) {
    this.binding = binding;
    this.context = context;
    this.dependencies = dependencies;
  }

  static async create(
    binding: SidecarBinding,
    context: SidecarServiceContext,
    dependencies: SubagentWorkerServiceDependencies = {},
  ): Promise<{ service: SubagentWorkerService; readyResult: unknown }> {
    if (binding.role !== "subagent") throw new Error(`Subagent worker received ${binding.role} binding`);
    return {
      service: new SubagentWorkerService(binding.value, context, dependencies),
      readyResult: { runId: binding.value.runId, childIndex: binding.value.childIndex },
    };
  }

  async command(command: SidecarCommand): Promise<unknown> {
    const subagentCommand = command as SubagentWorkerCommand;
    switch (subagentCommand.type) {
      case "subagentRun":
        return this.run(subagentCommand.request);
      case "refreshModelConfiguration": {
        if (subagentCommand.revision.generation <= this.modelConfigurationGeneration) return null;
        await this.modelRuntime?.refresh({ allowNetwork: false });
        if (this.session && this.modelRuntime) {
          const currentModel = this.session.model;
          if (currentModel) {
            const refreshed = this.modelRuntime.getModel(currentModel.provider, currentModel.id);
            if (
              refreshed &&
              isModelMateriallyDifferent(currentModel, refreshed) &&
              this.modelRuntime.hasConfiguredAuth(currentModel.provider)
            ) {
              await this.session.setModel(refreshed);
            }
          }
          const activeModel = this.session.model;
          const availableModels = this.modelRuntime.getAvailableSnapshot();
          if (this.controlState) {
            this.controlState = {
              ...this.controlState,
              model: activeModel
                ? { provider: activeModel.provider, id: activeModel.id, name: activeModel.name }
                : undefined,
              models: availableModels.map((item) => ({
                provider: item.provider,
                id: item.id,
                name: item.name,
                contextWindow: item.contextWindow,
                thinking: item.reasoning,
              })),
            };
          }
          this.publishControl();
        }
        this.modelConfigurationGeneration = subagentCommand.revision.generation;
        return null;
      }
      case "subagentBootstrap":
        return this.bootstrap();
      case "subagentCancel":
        this.assertRunId(subagentCommand.runId);
        this.cancelled = true;
        await this.session?.abort();
        return null;
      case "subagentSteer":
        this.assertRunId(subagentCommand.runId);
        if (!this.session) throw new Error("Subagent session is not running");
        await this.session.steer(subagentCommand.message);
        return null;
      case "ping":
        return { pong: true };
      default:
        throw new Error(`Unsupported subagent command: ${(subagentCommand as { type: string }).type}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelled = true;
    try {
      await this.session?.abort();
    } catch {
      // Session disposal remains authoritative.
    }
    if (this.session?.extensionRunner.hasHandlers("session_shutdown")) {
      await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
    }
    this.projector?.dispose();
    this.projector = undefined;
    this.extensionHost?.dispose();
    this.session?.dispose();
    this.session = undefined;
  }

  private async run(request: SubagentRunRequest): Promise<unknown> {
    if (this.disposed) throw new Error("Subagent worker is disposed");
    if (this.runStarted) throw new Error("Subagent worker accepts exactly one run");
    this.runStarted = true;
    this.validateRequest(request);

    process.env.PI_SUBAGENT_DEPTH = String(request.depth);
    process.env.PI_SUBAGENT_MAX_DEPTH = String(request.maxDepth);
    const supervisorChannel =
      request.parentSessionId && request.orchestratorTarget
        ? {
            channelDir: resolveSupervisorChannelDir(request.runId, request.agent, request.childIndex),
            orchestratorTarget: request.orchestratorTarget,
            orchestratorSessionId: request.parentSessionId,
          }
        : undefined;
    if (supervisorChannel) {
      ensureSupervisorChannelDir(supervisorChannel.channelDir);
      process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = supervisorChannel.orchestratorTarget;
      process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = supervisorChannel.orchestratorSessionId;
      process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = supervisorChannel.channelDir;
      process.env[SUBAGENT_RUN_ID_ENV] = request.runId;
      process.env[SUBAGENT_CHILD_AGENT_ENV] = request.agent;
      process.env[SUBAGENT_CHILD_INDEX_ENV] = String(request.childIndex);
      if (request.intercomSessionName) {
        process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = request.intercomSessionName;
      }
    } else {
      // Keep the service self-contained: a run without supervisor metadata must
      // not inherit channel identity from an earlier run in this process.
      delete process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV];
      delete process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV];
      delete process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV];
      delete process.env[SUBAGENT_RUN_ID_ENV];
      delete process.env[SUBAGENT_CHILD_AGENT_ENV];
      delete process.env[SUBAGENT_CHILD_INDEX_ENV];
      delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
    }
    const extensionFactories = [
      ...DesktopBuiltinProviderRegistry.getSubagentExtensionFactories(request.extensionProfile),
      ...(request.extensionProfile.includes("runtime") ? [createRuntimeExtension(request)] : []),
      ...(request.extensionProfile.includes("fanout") ? [createFanoutExtension(request, this.context)] : []),
      ...(this.dependencies.extensionFactories ?? []),
    ];
    const extensionSet = childExtensionSet(
      request,
      extensionFactories,
      validateChildExtensions(request.childExtensions),
    );
    const settingsManager = SettingsManager.create(request.cwd, this.binding.agentDir);
    if (this.binding.shellPath) settingsManager.applyDefaults({ shellPath: this.binding.shellPath });
    const modelRuntime = await ModelRuntime.create({
      credentials: new FileCredentialStore(join(this.binding.agentDir, "auth.json")),
      modelsPath: join(this.binding.agentDir, "models.json"),
      allowModelNetwork: false,
    });
    this.modelRuntime = modelRuntime;
    if (this.modelConfigurationGeneration > 0) await modelRuntime.refresh({ allowNetwork: false });
    const services = await createAgentSessionServices({
      cwd: request.cwd,
      agentDir: this.binding.agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        ...controlledResourceLoaderOptions(extensionSet, extensionFactories, {
          includeBuiltinSkills: request.inheritSkills,
        }),
        noSkills: !request.inheritSkills,
        noContextFiles: !request.inheritProjectContext,
        ...(request.systemPromptMode === "replace" && request.systemPrompt
          ? { systemPrompt: request.systemPrompt }
          : {}),
        appendSystemPrompt: [
          CHILD_BOUNDARY_INSTRUCTIONS,
          ...(request.systemPromptMode !== "replace" && request.systemPrompt ? [request.systemPrompt] : []),
        ],
      },
    });
    if (this.disposed || this.cancelled)
      throw new Error(this.disposed ? "Subagent worker is disposed" : "Subagent cancelled.");
    const extensionErrors = services.resourceLoader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      throw new Error(extensionErrors.map(({ path, error }) => `${path}: ${error}`).join("\n"));
    }
    if (services.diagnostics.some(({ type }) => type === "error")) {
      throw new Error(services.diagnostics.map(({ message }) => message).join("\n"));
    }
    const availableModels = await services.modelRuntime.getAvailable();
    const model = resolveModel(request, availableModels);
    if (request.model && !model) throw new Error(`Unknown model: ${request.model}`);
    const sessionManager = createSessionManager(request);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(model ? { model } : {}),
      ...(request.thinking ? { thinkingLevel: request.thinking as ThinkingLevel } : {}),
      ...(request.tools
        ? {
            tools: [...new Set([...request.tools, ...(request.structuredOutput ? ["structured_output"] : [])])],
          }
        : {}),
      sessionStartEvent: {
        type: "session_start",
        reason: request.sessionFile && existsSync(request.sessionFile) ? "resume" : "new",
      },
    });
    this.session = created.session;
    if (this.disposed || this.cancelled) {
      await created.session.abort().catch(() => undefined);
      created.session.dispose();
      this.session = undefined;
      throw new Error(this.disposed ? "Subagent worker is disposed" : "Subagent cancelled.");
    }
    this.extensionHost = new DesktopExtensionHost(
      () => this.publishControl(),
      () => [...created.session.state.pendingToolCalls],
    );
    await created.session.bindExtensions({
      uiContext: this.extensionHost.createContext(),
      mode: "rpc",
      commandContextActions: unavailableCommandActions(created.session),
    });
    if (this.disposed || this.cancelled) {
      await created.session.abort().catch(() => undefined);
      this.extensionHost.dispose();
      this.extensionHost = undefined;
      created.session.dispose();
      this.session = undefined;
      throw new Error(this.disposed ? "Subagent worker is disposed" : "Subagent cancelled.");
    }
    this.projector = new PiThreadProjector({
      projectId: request.projectId,
      session: created.session,
      publish: (batch) =>
        this.context.emit({
          type: "session-push",
          payload: { type: "timeline", projectId: request.projectId, threadId: created.session.sessionId, batch },
        }),
    });
    const contextUsage = created.session.getContextUsage();
    const activeModel = created.session.model;
    this.controlState = {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: request.projectId,
      threadId: created.session.sessionId,
      title: subagentSessionTitle(request.task),
      updatedAt: Date.now(),
      cwd: request.cwd,
      running: false,
      interaction: "read-only",
      queueModes: { steering: created.session.steeringMode, followUp: created.session.followUpMode },
      ...(activeModel ? { model: { provider: activeModel.provider, id: activeModel.id, name: activeModel.name } } : {}),
      models: availableModels.map((item) => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        contextWindow: item.contextWindow,
        thinking: item.reasoning,
      })),
      commands: [],
      thinkingLevel: created.session.thinkingLevel,
      thinkingLevels: created.session.getAvailableThinkingLevels(),
      ...(contextUsage
        ? {
            context: {
              tokens: contextUsage.tokens,
              contextWindow: contextUsage.contextWindow,
              percent: contextUsage.percent,
            },
          }
        : {}),
      readiness: { state: "ready" },
      hostRequests: [],
      extensionSet: { generation: extensionSet.generation, diagnostics: [], reloadRequired: false },
      extensionHost: this.extensionHost.hostState,
    };
    let announcedSessionFile = materializedSessionFile(created.session.sessionFile, created.session.sessionId);
    this.context.emit({
      type: "subagent-event",
      event: {
        type: "started",
        runId: request.runId,
        threadId: created.session.sessionId,
        ...(announcedSessionFile ? { sessionFile: announcedSessionFile } : {}),
        updatedAt: this.controlState.updatedAt,
      },
    });
    let assistantTurns = 0;
    let turnBudgetExceeded = false;
    const unsubscribe = created.session.subscribe((event) => {
      this.projectSessionEvent(event);
      if (!announcedSessionFile) {
        const materialized = materializedSessionFile(created.session.sessionFile, created.session.sessionId);
        if (materialized) {
          // Persisted session files materialize lazily, so announce the path as soon as it exists.
          announcedSessionFile = materialized;
          this.context.emit({
            type: "subagent-event",
            event: {
              type: "started",
              runId: request.runId,
              threadId: created.session.sessionId,
              sessionFile: materialized,
              updatedAt: this.controlState?.updatedAt,
            },
          });
        }
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "message_update",
            message: toJsonValue(event.message),
            assistantMessageEvent: toJsonValue(event.assistantMessageEvent),
          },
        });
      } else if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          assistantTurns += 1;
          const hardTurnLimit = request.turnBudget
            ? request.turnBudget.maxTurns + request.turnBudget.graceTurns
            : undefined;
          const hasToolCall =
            Array.isArray(event.message.content) && event.message.content.some((part) => part.type === "toolCall");
          if (hardTurnLimit !== undefined && assistantTurns >= hardTurnLimit && hasToolCall) {
            turnBudgetExceeded = true;
            void created.session.abort();
          }
        }
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "message_end",
            message: toJsonValue(event.message),
            updatedAt: this.controlState?.updatedAt,
          },
        });
      } else if (event.type === "tool_execution_start") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "tool_execution_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: toJsonValue(event.args),
          },
        });
      } else if (event.type === "tool_execution_update") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "tool_execution_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: toJsonValue(event.partialResult),
          },
        });
      } else if (event.type === "tool_execution_end") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "tool_execution_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: toJsonValue(event.result),
            isError: event.isError,
          },
        });
      }
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (request.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        void created.session.abort();
      }, request.timeoutMs);
      timeout.unref?.();
    }
    try {
      if (this.cancelled) throw new Error("Subagent cancelled.");
      await created.session.prompt(request.task);
      await created.session.waitForIdle();
      if (timedOut) throw new Error(`Subagent timed out after ${request.timeoutMs}ms.`);
      if (this.cancelled) throw new Error("Subagent cancelled.");
      if (turnBudgetExceeded) {
        throw new Error(`Subagent exceeded its turn budget (${request.turnBudget?.maxTurns}).`);
      }
      const sessionFile = created.session.sessionFile;
      const updatedAt = this.terminalUpdatedAt();
      this.context.emit({
        type: "subagent-event",
        event: { type: "completed", runId: request.runId, ...(sessionFile ? { sessionFile } : {}), updatedAt },
      });
      await this.context.flushEvents();
      return { status: "completed", ...(sessionFile ? { sessionFile } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sessionFile = created.session.sessionFile;
      const updatedAt = this.terminalUpdatedAt();
      this.context.emit({
        type: "subagent-event",
        event: {
          type: "failed",
          runId: request.runId,
          error: message,
          ...(timedOut ? { code: SUBAGENT_TIMEOUT_CODE } : {}),
          ...(sessionFile ? { sessionFile } : {}),
          updatedAt,
        },
      });
      await this.context.flushEvents();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  }

  private bootstrap(): SessionBootstrap {
    if (!this.projector || !this.controlState) throw new Error("Subagent session is not ready");
    this.projector.checkpoint();
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.controlState.projectId,
      threadId: this.controlState.threadId,
      timeline: this.projector.snapshot(),
      control: this.control(),
    };
  }

  private projectSessionEvent(event: AgentSessionEvent): void {
    if (!this.projector) return;
    try {
      this.projector.handle(event);
    } catch {
      this.projector.resync();
    }
    if (event.type === "message_end" && event.message.role === "user" && this.controlState) {
      if (this.initialPromptObserved) {
        this.controlState = {
          ...this.controlState,
          updatedAt: Math.max(this.controlState.updatedAt, event.message.timestamp),
        };
      } else {
        this.initialPromptObserved = true;
      }
    } else if (event.type === "agent_settled" && this.controlState) {
      this.runSettled = true;
      this.controlState = {
        ...this.controlState,
        updatedAt: Math.max(this.controlState.updatedAt, Date.now()),
      };
    }
    if (
      event.type === "agent_start" ||
      event.type === "agent_settled" ||
      event.type === "message_end" ||
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end" ||
      event.type === "compaction_start" ||
      event.type === "compaction_end" ||
      event.type === "summarization_retry_scheduled" ||
      event.type === "summarization_retry_attempt_start" ||
      event.type === "summarization_retry_finished"
    ) {
      this.publishControl();
    }
  }

  private control(): SessionControlState {
    if (!this.controlState || !this.projector || !this.session || !this.extensionHost) {
      throw new Error("Subagent session is not ready");
    }
    const contextUsage = this.session.getContextUsage();
    return {
      ...this.controlState,
      running: this.projector.snapshot().phase !== "idle",
      thinkingLevel: this.session.thinkingLevel,
      thinkingLevels: this.session.getAvailableThinkingLevels(),
      ...(contextUsage
        ? {
            context: {
              tokens: contextUsage.tokens,
              contextWindow: contextUsage.contextWindow,
              percent: contextUsage.percent,
            },
          }
        : {}),
      hostRequests: this.extensionHost.requests,
      extensionHost: this.extensionHost.hostState,
    };
  }

  private publishControl(): void {
    if (!this.controlState || !this.projector || !this.session || !this.extensionHost) return;
    this.controlState = { ...this.controlState, revision: this.controlState.revision + 1 };
    const control = this.control();
    this.context.emit({
      type: "session-push",
      payload: {
        type: "control",
        projectId: control.projectId,
        threadId: control.threadId,
        control,
      },
    });
  }

  private terminalUpdatedAt(): number {
    if (!this.controlState) return Date.now();
    if (!this.runSettled) {
      this.controlState = {
        ...this.controlState,
        updatedAt: Math.max(this.controlState.updatedAt, Date.now()),
      };
    }
    return this.controlState.updatedAt;
  }

  private validateRequest(request: SubagentRunRequest): void {
    if (
      request.projectId !== this.binding.projectId ||
      request.parentThreadId !== this.binding.parentThreadId ||
      request.runId !== this.binding.runId ||
      request.childIndex !== this.binding.childIndex
    ) {
      throw new Error("Subagent request identity does not match worker binding");
    }
    if (
      !Number.isSafeInteger(request.depth) ||
      !Number.isSafeInteger(request.maxDepth) ||
      request.depth < 1 ||
      request.maxDepth < request.depth
    ) {
      throw new Error("Subagent request has invalid depth limits");
    }
  }

  private assertRunId(runId: string): void {
    if (runId !== this.binding.runId) throw new Error(`Subagent run mismatch: ${runId}`);
  }
}

function subagentSessionTitle(task: string): string {
  const delegatedTask = /(?:^|\n)Task:\n([\s\S]*?)(?:\n\n##|$)/.exec(task)?.[1] ?? task;
  const firstLine = delegatedTask
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? "子智能体会话").replace(/\s+/g, " ").slice(0, 48);
}

function materializedSessionFile(sessionFile: string | undefined, expectedId: string): string | undefined {
  if (!sessionFile) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(8 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return undefined;
    const header: unknown = JSON.parse(firstLine);
    return typeof header === "object" &&
      header !== null &&
      "type" in header &&
      header.type === "session" &&
      "id" in header &&
      header.id === expectedId
      ? sessionFile
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function createSessionManager(request: SubagentRunRequest): SessionManager {
  if (!request.persistSession) return SessionManager.inMemory(request.cwd);
  if (request.sessionFile) return SessionManager.open(request.sessionFile, dirname(request.sessionFile), request.cwd);
  return SessionManager.create(request.cwd, request.sessionDir);
}

function resolveModel(request: SubagentRunRequest, models: readonly Model<Api>[]) {
  if (!request.model) return undefined;
  const slash = request.model.indexOf("/");
  if (slash > 0) {
    const provider = request.model.slice(0, slash);
    const id = request.model.slice(slash + 1);
    return models.find((model) => model.provider === provider && model.id === id);
  }
  return (
    models.find((model) => model.provider === request.preferredProvider && model.id === request.model) ??
    models.find((model) => model.id === request.model)
  );
}

function createFanoutExtension(request: SubagentRunRequest, context: SidecarServiceContext): InlineExtension {
  const runtime = new DesktopSubagentRuntime({
    projectId: request.projectId,
    parentThreadId: request.parentThreadId,
    parentWorker: request,
    childExtensions: request.childExtensions,
    requestHost: (hostRequest, onEvent) => context.requestHost(hostRequest, onEvent),
  });
  return {
    name: "desktop:subagent-fanout",
    factory: (api) => {
      registerFanoutChildSubagentExtension(api, { programmaticRuntime: runtime });
      api.on("session_shutdown", () => runtime.dispose());
    },
  };
}

function createRuntimeExtension(request: SubagentRunRequest): InlineExtension {
  return {
    name: "desktop:subagent-runtime",
    factory: (api) => {
      registerToolBudget(api, request);
      registerStructuredOutput(api, request);
      // Child intercom coordination through the shared supervisor channel. No-op
      // unless the launch carried supervisor metadata (env vars above).
      registerNativeSupervisorClient(api);
    },
  };
}

function registerToolBudget(api: ExtensionAPI, request: SubagentRunRequest): void {
  const budget = request.toolBudget;
  if (!budget) return;
  let toolCount = 0;
  let softNudged = false;
  api.on("tool_call", (event) => {
    toolCount += 1;
    if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
      softNudged = true;
      api.sendUserMessage(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
    }
    if (!shouldBlockToolForBudget(budget, event.toolName, toolCount)) return undefined;
    return { block: true, reason: toolBudgetBlockedMessage(budget, event.toolName, toolCount) };
  });
}

function registerStructuredOutput(api: ExtensionAPI, request: SubagentRunRequest): void {
  const structured = request.structuredOutput;
  if (!structured) return;
  try {
    rmSync(structured.outputPath, { force: true });
  } catch {
    // A stale output is ignored; the tool writes the authoritative value.
  }
  api.registerTool({
    name: "structured_output",
    label: "Structured Output",
    description: "Submit the required final structured output for this subagent step.",
    parameters: createStructuredOutputToolParameters(structured.schema) as never,
    async execute(_id, params: { value: unknown }) {
      const validation = await validateStructuredOutputValue(structured.schema, params.value);
      if (validation.status === "invalid")
        throw new Error(`Structured output validation failed: ${validation.message}`);
      mkdirSync(dirname(structured.outputPath), { recursive: true });
      writeFileSync(structured.outputPath, JSON.stringify(params.value), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Structured output captured." }],
        details: { path: structured.outputPath },
        terminate: true,
      };
    },
  });
}

function validateChildExtensions(extensions: readonly SubagentChildExtension[] | undefined): SubagentChildExtension[] {
  const seen = new Set<string>();
  return (extensions ?? []).map((extension) => {
    if (!isAbsolute(extension.path)) throw new Error(`Child extension path must be absolute: ${extension.path}`);
    if (seen.has(extension.path)) throw new Error(`Duplicate child extension path: ${extension.path}`);
    seen.add(extension.path);
    const stats = lstatSync(extension.path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Child extension path must be a regular non-symlink file: ${extension.path}`);
    }
    if (realpathSync(extension.path) !== extension.path) {
      throw new Error(`Child extension path must be canonical: ${extension.path}`);
    }
    if (!Array.isArray(extension.tools) || extension.tools.length === 0) {
      throw new Error(`Child extension tools are required: ${extension.path}`);
    }
    const tools = extension.tools.map((tool) => {
      if (!tool.trim() || tool.includes("/") || tool.includes("\\") || /\.[cm]?[jt]s$/i.test(tool)) {
        throw new Error(`Child extension has an invalid tool name: ${tool}`);
      }
      return tool;
    });
    if (new Set(tools).size !== tools.length)
      throw new Error(`Child extension tools are duplicated: ${extension.path}`);
    return { path: extension.path, tools };
  });
}

function childExtensionSet(
  request: SubagentRunRequest,
  factories: InlineExtension[],
  childExtensions: readonly SubagentChildExtension[],
) {
  return {
    generation: `subagent:${request.runId}:${request.childIndex}`,
    projectId: request.projectId,
    entries: [
      ...factories.map((factory, index) => ({
        id: typeof factory === "function" ? `inline-${index}` : factory.name,
        displayName: typeof factory === "function" ? `Inline ${index}` : factory.name,
        source: "builtin" as const,
        hostProfileVersion: 1 as const,
        capabilities: [],
      })),
      ...childExtensions.map((extension, index) => ({
        id: `child-extension-${index}`,
        displayName: basename(extension.path),
        source: "development" as const,
        entryPath: extension.path,
        hostProfileVersion: 1 as const,
        capabilities: ["tools.register" as const],
      })),
    ],
    diagnostics: [],
    resolvedAt: Date.now(),
  };
}

function unavailableCommandActions(session: AgentSession) {
  const unavailable = async (): Promise<never> => {
    throw new Error("Session replacement is unavailable in a subagent worker");
  };
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: unavailable,
    fork: unavailable,
    navigateTree: unavailable,
    switchSession: unavailable,
    reload: unavailable,
  };
}

/**
 * Returns true when two Model instances differ in fields that affect the
 * session (endpoint, config, capabilities, compat, headers,
 * thinkingLevelMap). Rejects different provider/id as non-material
 * (shouldn't happen in the refresh path).
 */
function isModelMateriallyDifferent(current: Model<Api>, candidate: Model<Api>): boolean {
  if (current.provider !== candidate.provider || current.id !== candidate.id) return false;
  return !isDeepStrictEqual(current, candidate);
}
