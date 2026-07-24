import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionAPI,
  type InlineExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { DesktopBuiltinProviderRegistry } from "../main/pi/desktop-builtin-provider.ts";
import { DesktopExtensionHost } from "../main/pi/desktop-extension-host.ts";
import { controlledResourceLoaderOptions } from "../main/pi/desktop-extension-runtime-policy.ts";
import registerFanoutChildSubagentExtension from "../main/pi/extensions/pi-subagents/src/extension/fanout-child.ts";
import { validateStructuredOutputValue } from "../main/pi/extensions/pi-subagents/src/runs/shared/structured-output.ts";
import {
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
} from "../main/pi/extensions/pi-subagents/src/runs/shared/tool-budget.ts";
import { DesktopSubagentRuntime } from "../main/pi/subagents/desktop-subagent-runtime.ts";
import type { SidecarBinding, SidecarCommand } from "../shared/sidecar-contracts.ts";
import { toJsonValue } from "../shared/sidecar-wire.ts";
import type { SubagentRunRequest, SubagentWorkerBinding, SubagentWorkerCommand } from "../shared/subagent-contracts.ts";
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
  private extensionHost?: DesktopExtensionHost;
  private runStarted = false;
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
    this.extensionHost?.dispose();
    this.session?.dispose();
    this.session = undefined;
  }

  private async run(request: SubagentRunRequest): Promise<unknown> {
    if (this.disposed) throw new Error("Subagent worker is disposed");
    if (this.runStarted) throw new Error("Subagent worker accepts exactly one run");
    this.runStarted = true;
    this.validateRequest(request);
    this.context.emit({ type: "subagent-event", event: { type: "started", runId: request.runId } });

    process.env.PI_SUBAGENT_DEPTH = String(request.depth);
    process.env.PI_SUBAGENT_MAX_DEPTH = String(request.maxDepth);
    const extensionFactories = [
      ...DesktopBuiltinProviderRegistry.getSubagentExtensionFactories(request.extensionProfile),
      ...(request.extensionProfile.includes("runtime") ? [createRuntimeExtension(request)] : []),
      ...(request.extensionProfile.includes("fanout") ? [createFanoutExtension(request, this.context)] : []),
      ...(this.dependencies.extensionFactories ?? []),
    ];
    const extensionSet = childExtensionSet(request, extensionFactories);
    const services = await createAgentSessionServices({
      cwd: request.cwd,
      agentDir: this.binding.agentDir,
      resourceLoaderOptions: {
        ...controlledResourceLoaderOptions(extensionSet, extensionFactories),
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
    const model = resolveModel(request, services.modelRegistry.getAvailable());
    if (request.model && !model) throw new Error(`Unknown model: ${request.model}`);
    const sessionManager = createSessionManager(request);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(model ? { model } : {}),
      ...(request.thinking ? { thinkingLevel: request.thinking as ThinkingLevel } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
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
      () => undefined,
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
    let assistantTurns = 0;
    let turnBudgetExceeded = false;
    const unsubscribe = created.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.context.emit({
          type: "subagent-event",
          event: { type: "text-delta", text: event.assistantMessageEvent.delta },
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
          event: { type: "message-end", message: toJsonValue(event.message) },
        });
      } else if (event.type === "tool_execution_start") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "tool-start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: toJsonValue(event.args),
          },
        });
      } else if (event.type === "tool_execution_update") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "tool-update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: toJsonValue(event.partialResult),
          },
        });
      } else if (event.type === "tool_execution_end") {
        this.context.emit({
          type: "subagent-event",
          event: {
            type: "tool-end",
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
      this.context.emit({
        type: "subagent-event",
        event: { type: "completed", runId: request.runId, ...(sessionFile ? { sessionFile } : {}) },
      });
      await this.context.flushEvents();
      return { status: "completed", ...(sessionFile ? { sessionFile } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sessionFile = created.session.sessionFile;
      this.context.emit({
        type: "subagent-event",
        event: { type: "failed", runId: request.runId, error: message, ...(sessionFile ? { sessionFile } : {}) },
      });
      await this.context.flushEvents();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
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

function createSessionManager(request: SubagentRunRequest): SessionManager {
  if (!request.persistSession) return SessionManager.inMemory(request.cwd);
  if (request.sessionFile) return SessionManager.open(request.sessionFile, request.sessionDir, request.cwd);
  return SessionManager.create(request.cwd, request.sessionDir);
}

function resolveModel(
  request: SubagentRunRequest,
  models: ReturnType<Awaited<ReturnType<typeof createAgentSessionServices>>["modelRegistry"]["getAvailable"]>,
) {
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
    parameters: {
      type: "object",
      properties: { value: structured.schema },
      required: ["value"],
      additionalProperties: false,
    } as never,
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

function childExtensionSet(request: SubagentRunRequest, factories: InlineExtension[]) {
  return {
    generation: `subagent:${request.runId}:${request.childIndex}`,
    projectId: request.projectId,
    entries: factories.map((factory, index) => ({
      id: typeof factory === "function" ? `inline-${index}` : factory.name,
      displayName: typeof factory === "function" ? `Inline ${index}` : factory.name,
      source: "builtin" as const,
      hostProfileVersion: 1 as const,
      capabilities: [],
    })),
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
