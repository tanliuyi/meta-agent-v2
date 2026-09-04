import { dirname, join } from "node:path";
import type { Thread } from "../../shared/contracts.ts";
import { deleteSessionCheckpoints } from "../pi/extensions/pi-rewind/src/core.ts";
import { SessionSupervisor } from "../pi/session-supervisor.ts";
import type { BrowserCapabilityPort } from "../session/browser-capability-port.ts";
import { SessionEventRouter } from "../session/session-event-router.ts";
import type { WorkspaceMutationPort } from "../session/workspace-mutation-port.ts";
import { MetadataWorkerClient } from "../sidecar/metadata-worker-client.ts";
import { SubagentWorkerRegistry } from "../sidecar/subagent-worker-registry.ts";
import { ThreadWorkerRegistry } from "../sidecar/thread-worker-registry.ts";
import { resolveWorkspaceMutationKey } from "../sidecar/workspace-mutation-key.ts";
import { SubagentSettingsConfigService } from "../subagents/subagent-settings-config-service.ts";
import type { CoreServices } from "./core-services.ts";
import type { PluginServices } from "./plugin-services.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";

/** metadata、worker registry 和 session supervisor 的运行服务集合。 */
export interface SessionServices {
  readonly metadata: MetadataWorkerClient;
  readonly subagents: SubagentWorkerRegistry;
  readonly workers: ThreadWorkerRegistry;
  readonly sessions: SessionSupervisor;
  readonly subagentSettings: SubagentSettingsConfigService;
  refreshActiveModelRuntimes(): Promise<void>;
  refreshMemoryConfiguration(): Promise<void>;
  dispose(): Promise<void>;
}

/** session 服务构造所需的核心服务和跨域端口。 */
export interface SessionServicesOptions {
  readonly context: DesktopRuntimeContext;
  readonly core: Pick<CoreServices, "projects" | "modelRuntime" | "isDesktopProviderAvailable">;
  readonly plugins: Pick<PluginServices, "extensionSourcePolicy" | "generationReferences">;
  readonly workspaceMutation: WorkspaceMutationPort;
  readonly browserCapability: BrowserCapabilityPort;
  readonly publishCatalogChanged: (thread: Thread) => void;
  readonly reportWorkerFailure: (projectId: string, threadId: string, error: Error) => void;
}

/** 构造 metadata、subagent、thread worker 与 supervisor，并绑定显式跨域端口。 */
/** 组装 session 运行图，并将 worker 回调绑定到显式 port。 */
export function createSessionServices(options: SessionServicesOptions): SessionServices {
  const { context, core, plugins, workspaceMutation, browserCapability } = options;
  const getWorkspaceKey = (projectId: string): Promise<string> =>
    resolveWorkspaceMutationKey(core.projects.getCwd(projectId));
  const metadata = new MetadataWorkerClient(
    context.manifest,
    context.agentDir,
    context.userDataDir,
    (scope, text) => context.sidecarLog.write(scope, text),
    plugins.generationReferences,
  );
  const router = new SessionEventRouter({ publishCatalogChanged: options.publishCatalogChanged });
  const subagents = new SubagentWorkerRegistry({
    manifest: context.manifest,
    agentDir: context.agentDir,
    ...(context.shellPath ? { shellPath: context.shellPath } : {}),
    getWorkspaceKey,
    log: (scope, text) => context.sidecarLog.write(scope, text),
    catalogChanged: (thread) => router.catalogChanged(thread),
    persistSession: (projectId, sessionFile, thread) =>
      metadata.registerExternal(projectId, core.projects.getCwd(projectId), sessionFile, thread),
    push: (payload, workerInstanceId, sidecarSequence) =>
      router.subagentEvent(payload, workerInstanceId, sidecarSequence),
    resync: (projectId, threadId, reason) => router.resyncRequired(projectId, threadId, reason),
  });
  router.bindSubagentAcknowledger((workerInstanceId, sidecarSequence) => {
    subagents.acknowledge(workerInstanceId, sidecarSequence);
  });
  const workers = new ThreadWorkerRegistry({
    manifest: context.manifest,
    metadata,
    userDataDir: context.userDataDir,
    agentDir: context.agentDir,
    ...(context.shellPath ? { shellPath: context.shellPath } : {}),
    extensionSourcePolicy: plugins.extensionSourcePolicy,
    generationReferences: plugins.generationReferences,
    getCwd: (projectId) => core.projects.getCwd(projectId),
    resolveSessionCwd: (projectId, cwd) => core.projects.resolveSessionCwd(projectId, cwd),
    getWorkspaceKey,
    push: (payload, workerInstanceId, sidecarSequence) =>
      router.threadEvent(payload, workerInstanceId, sidecarSequence),
    failed: (projectId, threadId, error) => {
      options.reportWorkerFailure(projectId, threadId, error);
      router.workerFailed(projectId, threadId, error);
    },
    resync: (projectId, threadId, reason) => router.resyncRequired(projectId, threadId, reason),
    catalogChanged: options.publishCatalogChanged,
    log: (scope, text) => context.sidecarLog.write(scope, text),
    handleHostRequest: (request, emit) => subagents.handleHostRequest(request, emit),
    hostWorkerFailed: (projectId, threadId) => subagents.cancelThread(projectId, threadId),
    listSubagentThreads: (projectId) => subagents.listThreads(projectId),
    isActiveSubagentThread: (projectId, threadId) => subagents.isActiveThread(projectId, threadId),
    attachSubagent: (projectId, threadId) => subagents.attach(projectId, threadId),
    readSubagentImageResource: (projectId, threadId, resourceId) =>
      subagents.readImageResource(projectId, threadId, resourceId),
    cancelSubagent: (projectId, threadId) => subagents.cancelActiveThread(projectId, threadId),
    acknowledgeSubagent: (workerInstanceId, sidecarSequence) =>
      subagents.acknowledge(workerInstanceId, sidecarSequence),
    beginSubagentWorkspaceMutation: (workspaceKey) => subagents.beginWorkspaceMutation(workspaceKey),
    endSubagentWorkspaceMutation: (workspaceKey) => subagents.endWorkspaceMutation(workspaceKey),
    beginTerminalWorkspaceMutation: async (workspaceKey) => {
      const projectKeys = await Promise.all(
        (await core.projects.list())
          .filter((project) => project.available)
          .map(async (project) => ({ projectId: project.id, workspaceKey: await getWorkspaceKey(project.id) })),
      );
      return workspaceMutation.beginTerminalRestore(
        projectKeys.filter((project) => project.workspaceKey === workspaceKey).map((project) => project.projectId),
      );
    },
    cleanupSessionCheckpoints: (projectId, threadIds) =>
      deleteSessionCheckpoints(core.projects.getCwd(projectId), threadIds),
    beginSubagentProjectMutation: (projectId) => subagents.beginProjectMutation(projectId),
    endSubagentProjectMutation: (projectId) => subagents.endProjectMutation(projectId),
    beginSubagentTreeMutation: (projectId, parentThreadId) => subagents.beginThreadMutation(projectId, parentThreadId),
    endSubagentTreeMutation: (projectId, parentThreadId) => subagents.endThreadMutation(projectId, parentThreadId),
    registerBrowserSession: (identity) => browserCapability.register(identity),
    revokeBrowserSession: (identity, token) => browserCapability.revoke(identity, token),
  });
  router.bindThreadAcknowledger((workerInstanceId, sidecarSequence) => {
    workers.acknowledge(workerInstanceId, sidecarSequence);
  });
  const sessions = new SessionSupervisor(core.projects, workers, {
    log: (scope, text) => context.sidecarLog.write(scope, text),
  });
  router.bindSupervisor(sessions);
  const subagentSettings = new SubagentSettingsConfigService({
    agentDir: context.agentDir,
    builtinAgentsDir: join(
      dirname(context.manifest.entries.subagent),
      "..",
      "main",
      "pi",
      "extensions",
      "pi-subagents",
      "agents",
    ),
    modelRuntime: core.modelRuntime,
    isDesktopProviderAvailable: core.isDesktopProviderAvailable,
    getProjectCwd: (projectId) => core.projects.getCwd(projectId),
  });
  let modelConfigurationGeneration = 0;
  let disposal: Promise<void> | undefined;

  return {
    metadata,
    subagents,
    workers,
    sessions,
    subagentSettings,
    async refreshActiveModelRuntimes(): Promise<void> {
      modelConfigurationGeneration += 1;
      const revision = { generation: modelConfigurationGeneration };
      const results = await Promise.allSettled([
        workers.refreshAllModels(revision),
        subagents.refreshAllModels(revision),
      ]);
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) throw new AggregateError(failures, "Failed to refresh active model runtimes");
    },
    async refreshMemoryConfiguration(): Promise<void> {
      plugins.extensionSourcePolicy.invalidate();
      await sessions.extensionSettingsChanged();
    },
    dispose(): Promise<void> {
      disposal ??= disposeSessionServices(sessions, subagents, metadata);
      return disposal;
    },
  };
}

async function disposeSessionServices(
  sessions: SessionSupervisor,
  subagents: SubagentWorkerRegistry,
  metadata: MetadataWorkerClient,
): Promise<void> {
  const errors: unknown[] = [];
  for (const [name, dispose] of [
    ["thread workers", () => sessions.dispose()],
    ["subagent workers", () => subagents.dispose()],
    ["metadata worker", () => metadata.dispose()],
  ] as const) {
    try {
      await dispose();
    } catch (error) {
      errors.push(new Error(`Failed to stop ${name}`, { cause: error }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose session services");
}
