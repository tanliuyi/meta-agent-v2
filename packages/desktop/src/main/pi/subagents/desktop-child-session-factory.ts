import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentChildExtension } from "../../../shared/subagent-contracts.ts";
import type {
  ChildSession,
  ChildSessionEvent,
  ChildSessionFactory,
  ChildSessionLaunch,
} from "../extensions/pi-subagents/src/runs/shared/child-session.ts";
import type { SubagentRuntime, SubagentRuntimeRunRequest } from "./subagent-runtime.ts";

function storageRequest(
  storage: ChildSessionLaunch["storage"],
): Pick<SubagentRuntimeRunRequest, "persistSession" | "sessionDir" | "sessionFile"> {
  if (storage.kind === "file") return { persistSession: true, sessionFile: storage.sessionFile };
  if (storage.kind === "dir") return { persistSession: true, sessionDir: storage.sessionDir };
  return { persistSession: storage.kind === "default" };
}

function runtimeConfigForWire(runtime: ChildSessionLaunch["runtime"]): SubagentRuntimeRunRequest["childRuntime"] {
  const {
    structuredOutput,
    watchdogStatus: _watchdogStatus,
    toolDiagnostic: _toolDiagnostic,
    runtimeAcknowledgements: _runtimeAcknowledgements,
    ...serializable
  } = runtime;
  return JSON.parse(
    JSON.stringify({
      ...serializable,
      ...(structuredOutput
        ? {
            structuredOutput: {
              schema: structuredOutput.schema,
              acceptanceReport: structuredOutput.acceptanceReport,
            },
          }
        : {}),
    }),
  ) as SubagentRuntimeRunRequest["childRuntime"];
}

function childExtensionsForLaunch(runtime: SubagentRuntime, launch: ChildSessionLaunch): SubagentChildExtension[] {
  const approved = new Map((runtime.getChildExtensions?.() ?? []).map((extension) => [extension.path, extension]));
  return launch.extensionPaths.flatMap((extensionPath) => {
    const extension = approved.get(extensionPath);
    return extension ? [{ path: extension.path, tools: [...extension.tools] }] : [];
  });
}

function createRemoteChildSession(runtime: SubagentRuntime, launch: ChildSessionLaunch): ChildSession {
  const listeners = new Set<(event: ChildSessionEvent) => void>();
  const messages: AgentMessage[] = [];
  let sessionFile = launch.storage.kind === "file" ? launch.storage.sessionFile : undefined;
  let sessionId = launch.runtime.sessionName ?? launch.runtime.runId ?? "desktop-subagent";
  let started = false;
  let promptPromise: Promise<void> | undefined;
  let disposed = false;

  const emit = (event: ChildSessionEvent): void => {
    if (event.type === "message_end" && event.message) messages.push(event.message as AgentMessage);
    for (const listener of listeners) listener(event);
  };

  const prompt = (text: string): Promise<void> => {
    if (promptPromise) return promptPromise;
    if (disposed) return Promise.reject(new Error("Desktop subagent session is disposed"));
    started = true;
    const runId = launch.runtime.runId;
    const agent = launch.runtime.agent;
    const childIndex = launch.runtime.childIndex;
    if (!runId || !agent || childIndex === undefined) {
      return Promise.reject(new Error("Desktop subagent launch is missing run identity"));
    }
    const request: SubagentRuntimeRunRequest = {
      runId,
      rootRunId: runId,
      childIndex,
      depth: launch.runtime.depth,
      maxDepth: launch.runtime.maxDepth ?? launch.runtime.depth,
      lineage: [],
      agent,
      task: text,
      cwd: launch.cwd,
      ...storageRequest(launch.storage),
      ...(launch.runtime.parentSessionId ? { parentSessionId: launch.runtime.parentSessionId } : {}),
      ...(launch.runtime.orchestratorTarget ? { orchestratorTarget: launch.runtime.orchestratorTarget } : {}),
      ...(launch.runtime.intercomSessionName ? { intercomSessionName: launch.runtime.intercomSessionName } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.tools ? { tools: [...launch.tools] } : {}),
      ...(launch.excludeTools ? { excludeTools: [...launch.excludeTools] } : {}),
      ...(launch.extensionPaths.length ? { extensionPaths: [...launch.extensionPaths] } : {}),
      ambientExtensions: launch.ambientExtensions,
      ...(launch.systemPrompt !== undefined ? { systemPrompt: launch.systemPrompt, systemPromptMode: "replace" } : {}),
      ...(launch.appendSystemPrompt !== undefined
        ? { systemPrompt: launch.appendSystemPrompt, systemPromptMode: "append" }
        : {}),
      inheritProjectContext: !launch.noContextFiles,
      inheritGlobalContext: launch.runtime.inheritGlobalContext,
      inheritSkills: !launch.noSkills,
      extensionProfile: ["provider", "memory", "runtime", ...(launch.runtime.fanoutChild ? ["fanout" as const] : [])],
      childExtensions: childExtensionsForLaunch(runtime, launch),
      ...(launch.runtime.toolBudget ? { toolBudget: launch.runtime.toolBudget } : {}),
      ...(launch.runtime.structuredOutput
        ? {
            structuredOutput: {
              schema: launch.runtime.structuredOutput.schema,
              ...(launch.runtime.structuredOutput.acceptanceReport
                ? { acceptanceReport: launch.runtime.structuredOutput.acceptanceReport }
                : {}),
            },
          }
        : {}),
      childRuntime: runtimeConfigForWire(launch.runtime),
    };
    promptPromise = (async () => {
      for await (const event of runtime.run(request)) {
        if (event.type === "started") {
          sessionFile = event.sessionFile ?? sessionFile;
          sessionId = event.threadId ?? sessionId;
          emit({ type: "agent_start" });
          continue;
        }
        if (event.type === "completed") {
          sessionFile = event.sessionFile ?? sessionFile;
          // The Desktop transport reports completion separately from pi's
          // child-session lifecycle. Project it to the two lifecycle events
          // consumed by the foreground completion drain.
          emit({ type: "agent_end", messages: [...messages], willRetry: false });
          emit({ type: "agent_settled" });
          continue;
        }
        if (event.type === "failed") throw new Error(event.error);
        if (event.type === "runtime_capture") {
          if (event.capture === "structured_output") {
            launch.runtime.structuredOutput?.capture(event.value, event.acceptanceReport);
          } else if (event.capture === "tool_diagnostic") {
            launch.runtime.toolDiagnostic?.(
              event.value as unknown as Parameters<NonNullable<typeof launch.runtime.toolDiagnostic>>[0],
            );
          } else {
            launch.runtime.runtimeAcknowledgements?.(event.value as string[]);
          }
          continue;
        }
        if (event.type === "child_event") {
          if (event.event && typeof event.event === "object" && !Array.isArray(event.event) && "type" in event.event) {
            emit(event.event as ChildSessionEvent);
          }
          continue;
        }
        emit(event as ChildSessionEvent);
      }
    })();
    return promptPromise;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt,
    steer: (text) => runtime.steer(launch.runtime.runId ?? "", launch.runtime.childIndex ?? 0, text),
    followUp: (text) => runtime.steer(launch.runtime.runId ?? "", launch.runtime.childIndex ?? 0, text),
    abort: () =>
      started ? runtime.cancel(launch.runtime.runId ?? "", launch.runtime.childIndex ?? 0) : Promise.resolve(),
    async dispose() {
      disposed = true;
      listeners.clear();
    },
    get messages() {
      return messages;
    },
    get sessionFile() {
      return sessionFile;
    },
    get sessionId() {
      return sessionId;
    },
    get modelId() {
      return launch.model;
    },
  };
}

/** 将 Desktop Main 管理的 worker transport 适配为上游 child-session contract。 */
export function createDesktopChildSessionFactory(runtime: SubagentRuntime): ChildSessionFactory {
  return {
    create: (launch) => Promise.resolve(createRemoteChildSession(runtime, launch)),
    dispose: () => runtime.dispose(),
  };
}
