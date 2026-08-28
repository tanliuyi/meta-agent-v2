import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserSessionIdentity } from "../../shared/browser-contracts.ts";
import type {
  ClearedQueue,
  DraftSessionConfig,
  HostResponse,
  SessionBootstrap,
  SessionBranchInput,
  SessionBranchResult,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionImageResource,
  SessionMentionCandidate,
  SessionPromptInput,
  SessionPushPayload,
  SessionReloadInput,
  SessionRemovePolicy,
  SessionRemoveResult,
  SessionResourceReloadInput,
  Thread,
} from "../../shared/contracts.ts";
import {
  previewFirstLines,
  THREAD_ASSISTANT_PREVIEW_MAX_CHARS,
  THREAD_USER_PREVIEW_MAX_CHARS,
} from "../../shared/contracts.ts";
import type {
  ApplyDesktopExtensionSetResult,
  DesktopExtensionDiagnostic,
  ResolvedExtensionEntry,
  ResolvedExtensionSet,
  SessionPluginOptions,
  StaleDraftExtensionSetErrorDetails,
} from "../../shared/desktop-extension-contracts.ts";
import type {
  SessionCheckpointDiffInput,
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreInput,
  SessionCheckpointRestoreResult,
} from "../../shared/pi-rewind-contracts.ts";
import type {
  CreationReservation,
  ModelConfigurationRevision,
  SidecarEvent,
  ThreadWorkerBinding,
} from "../../shared/sidecar-contracts.ts";
import type { SubagentHostRequest, SubagentRunEvent } from "../../shared/subagent-contracts.ts";
import { collectThreadDescendantIds } from "../../shared/thread-tree.ts";
import { readSessionFileHeader } from "../../sidecar/session-file-header.ts";
import type { DesktopExtensionSourcePolicy } from "../extensions/desktop-extension-source-policy.ts";
import { samePath } from "../path-identity.ts";
import type { MarketplaceGenerationReferenceTracker } from "../plugins/marketplace-generation-reference-tracker.ts";
import type { MetadataWorkerClient } from "./metadata-worker-client.ts";
import type { SidecarRuntimeManifest } from "./sidecar-runtime-manifest.ts";
import { SidecarRequestError, SidecarWorkerClient, type WorkerClientOptions } from "./worker-client.ts";

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_LIVE_WORKERS = 4;

export interface ThreadWorkerClient {
  readonly instanceId: string;
  readonly available?: boolean;
  readonly pid?: number;
  ready(): ReturnType<SidecarWorkerClient["ready"]>;
  request<T>(command: Parameters<SidecarWorkerClient["request"]>[0], timeoutMs?: number | null): Promise<T>;
  acknowledge(sequence: number): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

type ThreadWorkerSpawnBinding =
  | Extract<ThreadWorkerBinding, { mode: "create" }>
  | Omit<Extract<ThreadWorkerBinding, { mode: "open" }>, "sessionHeaderCwd">;

interface WorkerRecord {
  client: ThreadWorkerClient;
  projectId: string;
  threadId: string;
  cwd: string;
  workspaceKey: string;
  summary?: Thread;
  /** 子会话的父线程 id（create 模式传入），运行时 summary 更新时保持父级关联。 */
  parentThreadId?: string;
  initialBootstrap?: SessionBootstrap;
  lastActivityAt: number;
  inFlight: number;
  attachments: number;
  createRequestId?: string;
  sessionFile?: string;
  extensionSet: ResolvedExtensionSet;
  /** 会话级激活的插件子集；缺失表示继承项目级（全部激活）。 */
  enabledPluginIds?: string[];
  desiredExtensionGeneration: string;
  desiredExtensionDiagnostics: DesktopExtensionDiagnostic[];
  extensionDiagnostics: DesktopExtensionDiagnostic[];
  retired: boolean;
  /** 用户已请求关闭但 worker 仍 busy：条件清空后自动退役；新活动开始会取消。 */
  closeRequested: boolean;
  browserSessionIdentity: BrowserSessionIdentity;
  browserSessionToken?: string;
  shutdownPromise?: Promise<void>;
  failureReported?: boolean;
}

export interface ThreadWorkerRegistryOptions {
  manifest: SidecarRuntimeManifest;
  metadata: MetadataWorkerClient;
  userDataDir: string;
  agentDir: string;
  shellPath?: string;
  extensionSourcePolicy: DesktopExtensionSourcePolicy;
  generationReferences?: Pick<MarketplaceGenerationReferenceTracker, "retain" | "release">;
  getCwd(projectId: string): string;
  resolveSessionCwd(projectId: string, cwd: string): Promise<string>;
  getWorkspaceKey(projectId: string): Promise<string>;
  push(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void;
  failed(projectId: string, threadId: string, error: Error): void;
  resync(projectId: string, threadId: string, reason: string): void;
  catalogChanged?(thread: Thread): void;
  log?(scope: string, text: string): void;
  handleHostRequest?(request: SubagentHostRequest, emit: (event: SubagentRunEvent) => void): Promise<unknown>;
  hostWorkerFailed?(projectId: string, threadId: string): Promise<void>;
  listSubagentThreads?(projectId: string): readonly Thread[];
  isActiveSubagentThread?(projectId: string, threadId: string): boolean;
  attachSubagent?(projectId: string, threadId: string): Promise<SessionBootstrap | undefined>;
  readSubagentImageResource?(
    projectId: string,
    threadId: string,
    resourceId: string,
  ): Promise<SessionImageResource | undefined>;
  cancelSubagent?(projectId: string, threadId: string): Promise<void>;
  acknowledgeSubagent?(workerInstanceId: string, sidecarSequence: number): boolean;
  beginSubagentWorkspaceMutation?(workspaceKey: string): void;
  endSubagentWorkspaceMutation?(workspaceKey: string): void;
  beginTerminalWorkspaceMutation?(workspaceKey: string): Promise<() => void>;
  cleanupSessionCheckpoints?(projectId: string, threadIds: readonly string[]): Promise<void>;
  beginSubagentProjectMutation?(projectId: string): void;
  endSubagentProjectMutation?(projectId: string): void;
  beginSubagentTreeMutation?(projectId: string, parentThreadId: string): void;
  endSubagentTreeMutation?(projectId: string, parentThreadId: string): void;
  /** 从 ThreadWorkerBinding 受控注册浏览器会话身份并返回本 worker capability。 */
  registerBrowserSession?(identity: BrowserSessionIdentity): string | undefined;
  /** 撤销已退出 thread worker 的浏览器 capability。 */
  revokeBrowserSession?(identity: BrowserSessionIdentity, token: string): void;
  createWorkerClient?(options: WorkerClientOptions): ThreadWorkerClient;
  idleTtlMs?: number;
  maxLiveWorkers?: number;
}

export class StaleDraftExtensionSetError extends Error {
  readonly code = "STALE_DRAFT_EXTENSION_SET";
  readonly details: StaleDraftExtensionSetErrorDetails;

  constructor(requestedGeneration: string, currentGeneration: string) {
    super("Draft extension set changed; refresh the draft before creating a session");
    this.name = "StaleDraftExtensionSetError";
    this.details = { code: this.code, requestedGeneration, currentGeneration };
  }
}

export class StaleExtensionSetApplyError extends Error {
  readonly code = "STALE_EXTENSION_SET_APPLY";

  constructor(expectedGeneration: string, currentGeneration: string) {
    super(`Extension settings changed during apply: expected ${expectedGeneration}, got ${currentGeneration}`);
    this.name = "StaleExtensionSetApplyError";
  }
}

export class ThreadWorkerRegistry {
  private readonly options: ThreadWorkerRegistryOptions;
  private readonly records = new Map<string, WorkerRecord>();
  private readonly liveClients = new Map<string, ThreadWorkerClient>();
  private readonly pending = new Map<string, Promise<WorkerRecord>>();
  private readonly pendingCreations = new Map<string, Promise<SessionBootstrap>>();
  private readonly resourceReloadRequests = new Map<
    string,
    { promise: Promise<SessionCommandResult>; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly subagentAttachments = new Map<string, number>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly exclusiveWorkspaceKeys = new Set<string>();
  private readonly exclusiveThreads = new Set<string>();
  private readonly drainingThreads = new Set<string>();
  private readonly extensionApplyCompletions = new Map<string, Promise<void>>();
  private readonly blockedDevelopmentSets = new Map<string, string>();
  private readonly developmentCrashCounts = new Map<string, { count: number; lastAt: number }>();
  private readonly drainingProjects = new Set<string>();
  private readonly idleTimer: NodeJS.Timeout;
  private capacityTail = Promise.resolve();
  private reservedWorkerSlots = 0;
  private evictionRunning = false;
  private disposing = false;

  constructor(options: ThreadWorkerRegistryOptions) {
    this.options = options;
    const intervalMs = Math.max(1_000, Math.min(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 60_000));
    this.idleTimer = setInterval(() => void this.evictIdle(), intervalMs);
    this.idleTimer.unref();
  }

  async list(projectId: string): Promise<Thread[]> {
    this.assertProjectAvailable(projectId);
    const cwd = this.options.getCwd(projectId);
    const catalog = new Map((await this.options.metadata.list(projectId, cwd)).map((thread) => [thread.id, thread]));
    for (const record of this.records.values()) {
      if (record.projectId !== projectId || record.retired || !record.summary) continue;
      const indexed = catalog.get(record.threadId);
      catalog.set(record.threadId, {
        ...record.summary,
        ...(indexed?.parentThreadId ? { parentThreadId: indexed.parentThreadId } : {}),
        ...(indexed?.origin ? { origin: indexed.origin } : {}),
        ...(indexed?.parentThreadId ? { title: indexed.title, preview: indexed.preview } : {}),
      });
    }
    for (const thread of this.options.listSubagentThreads?.(projectId) ?? []) {
      const indexed = catalog.get(thread.id);
      catalog.set(thread.id, { ...indexed, ...thread, archived: indexed?.archived ?? thread.archived });
    }
    await this.reconcileCreationReservations(projectId);
    return [...catalog.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /** 同 list，但保留 session.jsonl 绝对路径（@ 提及会话引用用）。 */
  async listWithPaths(projectId: string): Promise<SessionMentionCandidate[]> {
    this.assertProjectAvailable(projectId);
    const cwd = this.options.getCwd(projectId);
    const catalog = new Map(
      (await this.options.metadata.listWithPaths(projectId, cwd)).map((thread) => [thread.id, thread]),
    );
    for (const record of this.records.values()) {
      if (record.projectId !== projectId || record.retired || !record.summary) continue;
      const indexed = catalog.get(record.threadId);
      if (indexed) {
        catalog.set(record.threadId, {
          ...record.summary,
          path: indexed.path,
          ...(indexed?.parentThreadId ? { parentThreadId: indexed.parentThreadId } : {}),
          ...(indexed?.origin ? { origin: indexed.origin } : {}),
          ...(indexed?.parentThreadId ? { title: indexed.title, preview: indexed.preview } : {}),
        });
      } else if (record.sessionFile) {
        catalog.set(record.threadId, { ...record.summary, path: record.sessionFile });
      }
    }
    for (const thread of this.options.listSubagentThreads?.(projectId) ?? []) {
      const indexed = catalog.get(thread.id);
      if (!indexed) continue;
      catalog.set(thread.id, { ...indexed, ...thread, path: indexed.path });
    }
    await this.reconcileCreationReservations(projectId);
    return [...catalog.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  acknowledge(workerInstanceId: string, sidecarSequence: number): void {
    const client = this.liveClients.get(workerInstanceId);
    if (client) client.acknowledge(sidecarSequence);
    else this.options.acknowledgeSubagent?.(workerInstanceId, sidecarSequence);
  }

  async getDraftConfig(projectId: string, cwd = this.options.getCwd(projectId)): Promise<DraftSessionConfig> {
    this.assertProjectAvailable(projectId);
    const { set: extensionSet, allEntries } = await this.options.extensionSourcePolicy.resolveWithAll(projectId);
    return this.options.metadata.getDraftConfig(projectId, cwd, extensionSet, allEntries);
  }

  getSessionCwd(projectId: string, threadId: string): string | undefined {
    const record = this.records.get(workerKey(projectId, threadId));
    return record && !record.retired ? record.cwd : undefined;
  }

  async getExtensionState(projectId: string, threadId: string) {
    this.assertProjectAvailable(projectId);
    const desired = await this.options.extensionSourcePolicy.resolve(projectId);
    const current = this.records.get(workerKey(projectId, threadId));
    if (current) {
      if (current.desiredExtensionGeneration !== desired.generation) {
        current.desiredExtensionDiagnostics = desired.diagnostics.map((diagnostic) => ({ ...diagnostic }));
      }
      current.desiredExtensionGeneration = desired.generation;
    }
    return {
      appliedGeneration: current?.extensionSet.generation,
      desiredGeneration: desired.generation,
      reloadRequired: Boolean(current && current.extensionSet.generation !== desired.generation),
      diagnostics: (current?.extensionSet.generation === desired.generation
        ? current.extensionDiagnostics
        : (current?.desiredExtensionDiagnostics ?? desired.diagnostics)
      ).map((diagnostic) => ({ ...diagnostic })),
    };
  }

  /** 会话级插件选择：返回全量可构建插件（含项目作用域外）与当前会话激活子集。 */
  async getSessionPluginOptions(projectId: string, threadId: string): Promise<SessionPluginOptions> {
    this.assertProjectAvailable(projectId);
    const { set, allEntries } = await this.options.extensionSourcePolicy.resolveWithAll(projectId);
    const record = this.records.get(workerKey(projectId, threadId));
    return {
      plugins: allEntries.map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        source: entry.source === "development" ? ("development" as const) : ("marketplace" as const),
        available: set.entries.some((active) => active.id === entry.id),
      })),
      enabledPluginIds: record?.enabledPluginIds ?? null,
    };
  }

  /** 替换当前 worker 以应用会话级插件选择（replacement spawn，失败回滚到旧子集）。 */
  async applySessionPluginSelection(
    projectId: string,
    threadId: string,
    enabledPluginIds: string[] | null,
    abortRunning = false,
  ): Promise<ApplyDesktopExtensionSetResult> {
    const normalized = enabledPluginIds ? [...enabledPluginIds] : undefined;
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    this.assertNotActiveSubagent(projectId, threadId);
    const key = workerKey(projectId, threadId);
    if (this.drainingThreads.has(key))
      throw new Error(`Extension set apply is already running for ${projectId}/${threadId}`);
    let completeApply!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeApply = resolve;
    });
    this.drainingThreads.add(key);
    this.extensionApplyCompletions.set(key, completion);
    try {
      return await this.withThreadLock(key, async () => {
        this.assertWorkspaceNotExclusive(workspaceKey);
        const current = await this.requireUnlocked(projectId, threadId);
        if (equalStringLists(current.enabledPluginIds, normalized)) {
          return { status: "unchanged" as const, generation: current.extensionSet.generation };
        }
        const { set: desired, allEntries } = await this.options.extensionSourcePolicy.resolveWithAll(projectId);
        if (current.inFlight > 0) throw new Error(`Cannot apply extensions while thread commands are in flight`);
        if (current.summary?.running) {
          if (!abortRunning) throw new Error("Thread is running; confirm abort before applying extensions");
          await current.client.request({ type: "cancel" }, null);
          await waitForIdleSummary(current);
        }
        if (!current.sessionFile) throw new Error("Cannot apply extensions before the session file is materialized");
        const previousSet = cloneExtensionSet(current.extensionSet);
        const previousEnabled = current.enabledPluginIds;
        const attachments = current.attachments;
        const sessionFile = current.sessionFile;
        this.options.resync(projectId, threadId, "extension-set-applying");
        current.retired = true;
        await this.awaitRecordShutdown(current);
        if (this.records.get(key) === current) this.records.delete(key);
        let replacement: WorkerRecord | undefined;
        try {
          replacement = await this.spawn({
            mode: "open",
            projectId,
            cwd: this.options.getCwd(projectId),
            agentDir: this.options.agentDir,
            ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
            threadId,
            sessionFile,
            ...(normalized ? { enabledPluginIds: normalized } : {}),
            extensionSet: buildSessionExtensionSet(desired, allEntries, normalized),
          });
        } catch (error) {
          try {
            if (replacement && !replacement.retired) {
              replacement.retired = true;
              await this.awaitRecordShutdown(replacement);
              if (this.records.get(key) === replacement) this.records.delete(key);
            }
          } finally {
            const rollback = await this.spawn({
              mode: "open",
              projectId,
              cwd: this.options.getCwd(projectId),
              agentDir: this.options.agentDir,
              ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
              threadId,
              sessionFile,
              ...(previousEnabled ? { enabledPluginIds: previousEnabled } : {}),
              extensionSet: previousSet,
            });
            activateAppliedRecord(rollback, attachments);
            rollback.desiredExtensionGeneration = desired.generation;
            rollback.desiredExtensionDiagnostics = [
              ...desired.diagnostics.map((diagnostic) => ({ ...diagnostic })),
              ...desired.entries.map((entry) => ({
                extensionId: entry.id,
                source: entry.source,
                extensionSetGeneration: desired.generation,
                projectId,
                threadId,
                phase: "start" as const,
                code: "DESKTOP_EXTENSION_STARTUP_FAILED",
                message: error instanceof Error ? error.message : String(error),
              })),
            ];
            this.options.resync(projectId, threadId, "extension-set-rollback");
          }
          return {
            status: "rolled-back" as const,
            generation: previousSet.generation,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (!replacement) throw new Error("Replacement worker is unavailable after successful startup");
        activateAppliedRecord(replacement, attachments);
        this.options.resync(projectId, threadId, "extension-set-applied");
        return { status: "applied" as const, generation: desired.generation };
      });
    } finally {
      this.drainingThreads.delete(key);
      if (this.extensionApplyCompletions.get(key) === completion) this.extensionApplyCompletions.delete(key);
      completeApply();
    }
  }

  async extensionSettingsChanged(): Promise<void> {
    const projects = new Set(
      [...this.records.values()].filter((record) => !record.retired).map((record) => record.projectId),
    );
    for (const projectId of projects) {
      const desired = await this.options.extensionSourcePolicy.resolve(projectId);
      for (const record of this.records.values()) {
        if (record.retired || record.projectId !== projectId) continue;
        record.desiredExtensionGeneration = desired.generation;
        record.desiredExtensionDiagnostics = desired.diagnostics.map((diagnostic) => ({ ...diagnostic }));
        if (record.extensionSet.generation !== desired.generation) {
          this.options.resync(record.projectId, record.threadId, "extension-settings-changed");
        }
      }
    }
  }

  create(input: SessionCreateInput): Promise<SessionBootstrap> {
    const key = `${input.projectId}\0${input.createRequestId}`;
    const current = this.pendingCreations.get(key);
    if (current) return current;
    const pending = this.createOnce(input).finally(() => this.pendingCreations.delete(key));
    this.pendingCreations.set(key, pending);
    return pending;
  }

  private async createOnce(input: SessionCreateInput): Promise<SessionBootstrap> {
    this.assertProjectAvailable(input.projectId);
    const workspaceKey = await this.options.getWorkspaceKey(input.projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    const recovered = await this.recoverCreationRequest(input.projectId, input.createRequestId);
    if (recovered) return recovered;
    const projectCwd = this.options.getCwd(input.projectId);
    const cwd = input.worktreePath ?? projectCwd;
    const { set: extensionSet, allEntries } = await this.options.extensionSourcePolicy.resolveWithAll(input.projectId);
    if (input.extensionSetGeneration !== extensionSet.generation) {
      throw new StaleDraftExtensionSetError(input.extensionSetGeneration, extensionSet.generation);
    }
    this.assertProjectAvailable(input.projectId);
    const sessionId = randomUUID();
    this.writeCreationReservation(
      input.projectId,
      projectCwd,
      cwd,
      sessionId,
      input.createRequestId,
      "reserved",
      undefined,
    );
    // 父会话通常在 registry 中有活跃 worker（sessionFile 已知）；冷会话回退到 metadata 索引。
    const parentSessionFile =
      input.parentThreadId &&
      (this.records.get(workerKey(input.projectId, input.parentThreadId))?.sessionFile ??
        (await this.options.metadata.resolve(input.projectId, projectCwd, input.parentThreadId)).path);
    const binding: ThreadWorkerBinding = {
      mode: "create",
      projectId: input.projectId,
      projectCwd,
      cwd,
      agentDir: this.options.agentDir,
      ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
      sessionId,
      createInput: input,
      ...(parentSessionFile ? { parentSessionFile } : {}),
      extensionSet: buildSessionExtensionSet(extensionSet, allEntries, input.enabledPluginIds),
    };
    const record = await this.spawn(binding);
    if (record.retired || record.client.available === false) {
      await this.awaitRecordShutdown(record);
      throw new Error(`Created thread worker generation was unavailable before registration: ${sessionId}`);
    }
    const bootstrap = record.initialBootstrap;
    record.initialBootstrap = undefined;
    if (!bootstrap) {
      record.retired = true;
      await this.awaitRecordShutdown(record);
      const key = workerKey(input.projectId, sessionId);
      if (this.records.get(key) === record) this.records.delete(key);
      throw new Error("Created thread worker did not return an initial bootstrap");
    }
    if (bootstrap.threadId !== sessionId) {
      record.retired = true;
      await this.awaitRecordShutdown(record);
      const key = workerKey(input.projectId, bootstrap.threadId);
      if (this.records.get(key) === record) this.records.delete(key);
      throw new Error(`Created session ID mismatch: expected ${sessionId}, got ${bootstrap.threadId}`);
    }
    record.threadId = bootstrap.threadId;
    record.parentThreadId = input.parentThreadId;
    record.summary = {
      ...summaryFromBootstrap(bootstrap),
      ...(record.parentThreadId ? { parentThreadId: record.parentThreadId } : {}),
    };
    const key = workerKey(input.projectId, bootstrap.threadId);
    if (record.retired) {
      await this.awaitRecordShutdown(record);
      throw new Error(`Created thread worker generation was unavailable before registration: ${key}`);
    }
    this.records.set(key, record);
    record.inFlight -= 1;
    return decorateBootstrap(record, bootstrap);
  }

  async attach(projectId: string, threadId: string): Promise<SessionBootstrap> {
    let subagentBootstrap: SessionBootstrap | undefined;
    try {
      subagentBootstrap = await this.options.attachSubagent?.(projectId, threadId);
    } catch (error) {
      // 只有当 subagent 已经不再活跃（运行在 bootstrap 期间结束）时才回退到普通 thread worker，
      // 避免在写入者仍存活时打开第二个写入者。
      if (this.options.isActiveSubagentThread?.(projectId, threadId)) throw error;
      this.options.log?.(
        `thread:${projectId}`,
        `Subagent attach fell back to a thread worker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (subagentBootstrap) {
      const key = workerKey(projectId, threadId);
      this.subagentAttachments.set(key, (this.subagentAttachments.get(key) ?? 0) + 1);
      return subagentBootstrap;
    }
    const bootstrap = await this.use(
      projectId,
      threadId,
      async (record) => {
        const result = await record.client.request<SessionBootstrap>({ type: "bootstrap" }, 30_000);
        record.attachments += 1;
        this.cancelRequestedClose(record);
        return decorateBootstrap(record, result);
      },
      true,
    );
    return bootstrap;
  }

  /** 仅确保 thread worker 已冷启并驻留在 records 中，不建立 attachment 或返回 bootstrap。 */
  prewarm(projectId: string, threadId: string): Promise<void> {
    if (this.options.isActiveSubagentThread?.(projectId, threadId)) return Promise.resolve();
    return this.use(projectId, threadId, async () => undefined);
  }

  /** 立即退役无 attachment 且已完成的 thread worker；busy thread 记录关闭意图，条件清空后自动退役。 */
  async close(projectId: string, threadId: string): Promise<void> {
    if (this.options.isActiveSubagentThread?.(projectId, threadId)) return;
    const key = workerKey(projectId, threadId);
    await this.withThreadLock(key, async () => {
      const record = this.records.get(key);
      if (!record) return;
      if (record.summary?.running || record.inFlight > 0 || record.attachments > 0) {
        record.closeRequested = true;
        return;
      }
      record.retired = true;
      await this.awaitRecordShutdown(record);
      if (this.records.get(key) === record) this.records.delete(key);
    });
  }

  /** 待定的关闭意图：running/inFlight/attachments 全部清零后自动退役（幂等）。 */
  private async retireRequestedCloseIfIdle(key: string): Promise<void> {
    let record: WorkerRecord | undefined;
    let proceed = false;
    await this.withThreadLock(key, async () => {
      const current = this.records.get(key);
      if (!current || !current.closeRequested) return;
      if (current.summary?.running || current.inFlight > 0 || current.attachments > 0) return;
      current.closeRequested = false;
      current.retired = true;
      record = current;
      proceed = true;
    });
    if (!proceed || !record) return;
    try {
      await this.awaitRecordShutdown(record);
    } finally {
      await this.withThreadLock(key, async () => {
        if (this.records.get(key) === record) this.records.delete(key);
      });
    }
  }

  private requestRetireRequestedCloseIfIdle(key: string): void {
    void this.retireRequestedCloseIfIdle(key).catch((error: unknown) =>
      this.options.log?.("thread-close", error instanceof Error ? error.message : String(error)),
    );
  }

  /** 新的会话活动（attach/prompt/respond）表明用户仍在用该 worker：取消待定的关闭。 */
  private cancelRequestedClose(record: WorkerRecord): void {
    record.closeRequested = false;
  }

  detach(projectId: string, threadId: string): void {
    const key = workerKey(projectId, threadId);
    const subagentAttachmentCount = this.subagentAttachments.get(key) ?? 0;
    const record = this.records.get(key);
    // 活跃 subagent 线程只存在 subagent lease；完成后优先扣减 thread worker lease，
    // 两类 lease 短暂并存时计数在全部释放后收敛，不会残留。
    const useSubagentLease =
      subagentAttachmentCount > 0 &&
      (this.options.isActiveSubagentThread?.(projectId, threadId) === true || !record || record.attachments === 0);
    if (useSubagentLease) {
      if (subagentAttachmentCount === 1) this.subagentAttachments.delete(key);
      else this.subagentAttachments.set(key, subagentAttachmentCount - 1);
      return;
    }
    if (record && record.attachments > 0) {
      record.attachments -= 1;
      if (record.attachments === 0) {
        this.requestCapacityTrim();
        this.requestRetireRequestedCloseIfIdle(key);
      }
    }
  }

  async prompt(input: SessionPromptInput): Promise<SessionCommandResult> {
    return this.use(input.projectId, input.threadId, (record) =>
      record.client.request({ type: "prompt", input }, null),
    );
  }

  async edit(input: SessionEditInput): Promise<SessionCommandResult> {
    return this.use(input.projectId, input.threadId, (record) => record.client.request({ type: "edit", input }, null));
  }

  async readImageResource(
    projectId: string,
    threadId: string,
    resourceId: string,
  ): Promise<SessionImageResource | undefined> {
    if (this.options.isActiveSubagentThread?.(projectId, threadId)) {
      const readSubagentImageResource = this.options.readSubagentImageResource;
      if (!readSubagentImageResource) throw new Error("Active subagent image resources are unavailable");
      return readSubagentImageResource(projectId, threadId, resourceId);
    }
    return this.use(projectId, threadId, (record) =>
      record.client.request<SessionImageResource | undefined>({ type: "getImageResource", resourceId }, 30_000),
    );
  }

  async reload(input: SessionReloadInput): Promise<SessionCommandResult> {
    return this.use(input.projectId, input.threadId, (record) =>
      record.client.request({ type: "reload", input }, null),
    );
  }

  async reloadResources(input: SessionResourceReloadInput): Promise<SessionCommandResult> {
    const { projectId, threadId, requestId } = input;
    const requestKey = `${workerKey(projectId, threadId)}\0${requestId}`;
    const existing = this.resourceReloadRequests.get(requestKey);
    if (existing) return existing.promise;
    const promise = this.reloadResourcesOnce(projectId, threadId, requestId);
    const entry: { promise: Promise<SessionCommandResult>; timer?: ReturnType<typeof setTimeout> } = { promise };
    this.resourceReloadRequests.set(requestKey, entry);
    const scheduleExpiry = () => {
      if (this.resourceReloadRequests.get(requestKey) !== entry) return;
      entry.timer = setTimeout(() => this.resourceReloadRequests.delete(requestKey), 60_000);
      entry.timer.unref();
    };
    void promise.then(scheduleExpiry, scheduleExpiry);
    return promise;
  }

  private async reloadResourcesOnce(
    projectId: string,
    threadId: string,
    requestId: string,
  ): Promise<SessionCommandResult> {
    const desired = await this.options.extensionSourcePolicy.resolve(projectId);
    try {
      const result = await this.applyExtensionSet(projectId, threadId, desired.generation);
      if (result.status === "rolled-back") {
        return { accepted: false, queued: false, error: result.error };
      }
      if (result.status === "unchanged") {
        return await this.runExclusive(projectId, threadId, (record) =>
          record.client.request<SessionCommandResult>(
            {
              type: "reloadResources",
              input: {
                requestId,
                projectId,
                threadId,
              },
            },
            null,
          ),
        );
      }
      return { accepted: true, queued: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("commands are in flight") ||
        message.includes("confirm abort") ||
        message.includes("Cannot reload resources")
      ) {
        return { accepted: false, queued: false, error: message };
      }
      throw error;
    }
  }

  async getCheckpointDiff(input: SessionCheckpointDiffInput): Promise<SessionCheckpointDiffResult> {
    return this.use(input.projectId, input.threadId, (record) =>
      record.client.request<SessionCheckpointDiffResult>(
        {
          type: "getCheckpointDiff",
          fromCheckpointId: input.fromCheckpointId,
          toCheckpointId: input.toCheckpointId,
          path: input.path,
        },
        35_000,
      ),
    );
  }

  async restoreCheckpoint(input: SessionCheckpointRestoreInput): Promise<SessionCheckpointRestoreResult> {
    return this.runWorkspaceExclusive(input.projectId, input.threadId, (record) =>
      record.client.request<SessionCheckpointRestoreResult>(
        {
          type: "restoreCheckpoint",
          checkpointId: input.checkpointId,
          expectedCheckpointId: input.expectedCheckpointId,
        },
        null,
      ),
    );
  }

  async branch(input: SessionBranchInput): Promise<SessionBranchResult> {
    const result = await this.use(input.projectId, input.threadId, (record) =>
      record.client.request<SessionBranchResult>({ type: "branch", input }, null),
    );
    return result;
  }

  async cancel(projectId: string, threadId: string): Promise<ClearedQueue> {
    if (this.options.isActiveSubagentThread?.(projectId, threadId)) {
      const cancelSubagent = this.options.cancelSubagent;
      if (!cancelSubagent) throw new Error("Active subagent cancellation is unavailable");
      await cancelSubagent(projectId, threadId);
      return { steering: [], followUp: [] };
    }
    return this.use(projectId, threadId, (record) => record.client.request<ClearedQueue>({ type: "cancel" }));
  }

  async clearQueue(projectId: string, threadId: string): Promise<ClearedQueue> {
    return this.use(projectId, threadId, (record) => record.client.request({ type: "clearQueue" }));
  }

  async compact(projectId: string, threadId: string): Promise<void> {
    await this.use(projectId, threadId, (record) => record.client.request({ type: "compact" }, null));
  }

  async refreshModels(projectId: string, threadId: string): Promise<void> {
    await this.use(projectId, threadId, (record) => record.client.request({ type: "refreshModels" }));
  }

  async refreshAllModels(revision: ModelConfigurationRevision): Promise<void> {
    const records = [...this.records.values()].filter((record) => !record.retired && record.client.available !== false);
    const results = await Promise.allSettled(
      records.map((record) => record.client.request({ type: "refreshModelConfiguration", revision })),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            new Error(
              `Thread model refresh failed for ${records[index]?.projectId}/${records[index]?.threadId}: ${
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              }`,
              { cause: result.reason },
            ),
          ]
        : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "One or more thread workers failed to refresh models");
  }

  async setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void> {
    await this.use(projectId, threadId, (record) => record.client.request({ type: "setModel", provider, modelId }));
  }

  async setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void> {
    await this.use(projectId, threadId, (record) => record.client.request({ type: "setThinking", level }));
  }

  async applyExtensionSet(
    projectId: string,
    threadId: string,
    expectedDesiredGeneration: string,
    abortRunning = false,
  ): Promise<ApplyDesktopExtensionSetResult> {
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    this.assertNotActiveSubagent(projectId, threadId);
    const key = workerKey(projectId, threadId);
    if (this.drainingThreads.has(key))
      throw new Error(`Extension set apply is already running for ${projectId}/${threadId}`);
    let completeApply!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeApply = resolve;
    });
    this.drainingThreads.add(key);
    this.extensionApplyCompletions.set(key, completion);
    try {
      return await this.withThreadLock(key, async () => {
        this.assertWorkspaceNotExclusive(workspaceKey);
        const current = await this.requireUnlocked(projectId, threadId);
        const { set: desired, allEntries } = await this.options.extensionSourcePolicy.resolveWithAll(projectId);
        if (desired.generation !== expectedDesiredGeneration) {
          throw new StaleExtensionSetApplyError(expectedDesiredGeneration, desired.generation);
        }
        current.desiredExtensionGeneration = desired.generation;
        current.desiredExtensionDiagnostics = desired.diagnostics.map((diagnostic) => ({ ...diagnostic }));
        if (current.extensionSet.generation === desired.generation) {
          return { status: "unchanged", generation: desired.generation };
        }
        if (current.inFlight > 0) throw new Error(`Cannot apply extensions while thread commands are in flight`);
        if (current.summary?.running) {
          if (!abortRunning) throw new Error("Thread is running; confirm abort before applying extensions");
          await current.client.request({ type: "cancel" }, null);
          await waitForIdleSummary(current);
        }
        if (!current.sessionFile) throw new Error("Cannot apply extensions before the session file is materialized");
        const previousSet = cloneExtensionSet(current.extensionSet);
        const attachments = current.attachments;
        const sessionFile = current.sessionFile;
        this.options.resync(projectId, threadId, "extension-set-applying");
        current.retired = true;
        await this.awaitRecordShutdown(current);
        if (this.records.get(key) === current) this.records.delete(key);
        let replacement: WorkerRecord | undefined;
        let latestDesired = desired;
        try {
          replacement = await this.spawn({
            mode: "open",
            projectId,
            cwd: this.options.getCwd(projectId),
            agentDir: this.options.agentDir,
            ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
            threadId,
            sessionFile,
            ...(current.enabledPluginIds ? { enabledPluginIds: current.enabledPluginIds } : {}),
            extensionSet: buildSessionExtensionSet(desired, allEntries, current.enabledPluginIds),
          });
          latestDesired = await this.options.extensionSourcePolicy.resolve(projectId);
          if (latestDesired.generation !== expectedDesiredGeneration) {
            throw new StaleExtensionSetApplyError(expectedDesiredGeneration, latestDesired.generation);
          }
        } catch (error) {
          try {
            latestDesired = await this.options.extensionSourcePolicy.resolve(projectId);
          } catch {
            // Rollback remains available even when the desired set can no longer be resolved.
          }
          if (replacement && !replacement.retired) {
            replacement.retired = true;
            await this.awaitRecordShutdown(replacement);
            if (this.records.get(key) === replacement) this.records.delete(key);
          }
          const rollback = await this.spawn({
            mode: "open",
            projectId,
            cwd: this.options.getCwd(projectId),
            agentDir: this.options.agentDir,
            ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
            threadId,
            sessionFile,
            extensionSet: previousSet,
          });
          activateAppliedRecord(rollback, attachments);
          rollback.desiredExtensionGeneration = latestDesired.generation;
          rollback.desiredExtensionDiagnostics = [
            ...latestDesired.diagnostics.map((diagnostic) => ({ ...diagnostic })),
            ...(latestDesired.generation === desired.generation ? desired.entries : []).map((entry) => ({
              extensionId: entry.id,
              source: entry.source,
              extensionSetGeneration: desired.generation,
              projectId,
              threadId,
              phase: "start" as const,
              code: "DESKTOP_EXTENSION_STARTUP_FAILED",
              message: error instanceof Error ? error.message : String(error),
            })),
          ];
          this.options.resync(projectId, threadId, "extension-set-rollback");
          return {
            status: "rolled-back",
            generation: previousSet.generation,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (!replacement) throw new Error("Replacement worker is unavailable after successful startup");
        activateAppliedRecord(replacement, attachments);
        this.options.resync(projectId, threadId, "extension-set-applied");
        return { status: "applied", generation: desired.generation };
      });
    } finally {
      this.drainingThreads.delete(key);
      if (this.extensionApplyCompletions.get(key) === completion) this.extensionApplyCompletions.delete(key);
      completeApply();
    }
  }

  async respond(projectId: string, threadId: string, response: HostResponse): Promise<void> {
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    const key = workerKey(projectId, threadId);
    let record!: WorkerRecord;
    await this.withThreadLock(key, async () => {
      this.assertWorkspaceNotExclusive(workspaceKey);
      const current = this.records.get(key);
      if (!current) throw new Error("Host UI response targets an unavailable thread worker");
      if (response.workerInstanceId && response.workerInstanceId !== current.client.instanceId) {
        throw new Error("Host UI response targets a stale thread worker generation");
      }
      record = current;
      record.inFlight += 1;
      this.cancelRequestedClose(record);
    });
    try {
      await record.client.request({ type: "respondHostUi", response }, 10_000);
    } catch (error) {
      if (isUnknownOutcome(error)) this.retireAfterUnknown(key, record, error);
      throw error;
    } finally {
      await this.withThreadLock(key, async () => {
        record.inFlight -= 1;
      });
      this.requestRetireRequestedCloseIfIdle(key);
    }
  }

  async rename(projectId: string, threadId: string, title: string): Promise<void> {
    this.assertNotActiveSubagent(projectId, threadId);
    await this.withThreadLock(workerKey(projectId, threadId), async () => {
      this.assertProjectAvailable(projectId);
      const current = this.records.get(workerKey(projectId, threadId));
      if (current) {
        try {
          await current.client.request({ type: "rename", title }, 30_000);
          current.summary = await current.client.request<Thread>({ type: "getSummary", archived: false }, 30_000);
          if (current.sessionFile) {
            await this.persistMetadata(current, current.summary);
          }
        } catch (error) {
          if (isUnknownOutcome(error)) this.retireAfterUnknown(workerKey(projectId, threadId), current, error);
          throw error;
        }
        return;
      }
      await this.options.metadata.renameCold(projectId, this.options.getCwd(projectId), threadId, title);
    });
  }

  async remove(projectId: string, threadId: string, policy: SessionRemovePolicy): Promise<SessionRemoveResult> {
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    const barrierThreadIds = [threadId];
    this.options.beginSubagentTreeMutation?.(projectId, threadId);
    try {
      const catalog = await this.list(projectId);
      const descendantIds = collectThreadDescendantIds(catalog, threadId);
      for (const descendantId of [...descendantIds].sort()) {
        this.options.beginSubagentTreeMutation?.(projectId, descendantId);
        barrierThreadIds.push(descendantId);
      }
      const result = await this.removeTree(projectId, threadId, policy, catalog, descendantIds);
      try {
        this.assertWorkspaceNotExclusive(workspaceKey);
        await this.options.cleanupSessionCheckpoints?.(projectId, result.removedThreadIds);
      } catch (error) {
        this.options.log?.(`checkpoint-cleanup:${projectId}`, error instanceof Error ? error.message : String(error));
      }
      return result;
    } finally {
      for (const barrierThreadId of [...barrierThreadIds].reverse()) {
        this.options.endSubagentTreeMutation?.(projectId, barrierThreadId);
      }
    }
  }

  private async removeTree(
    projectId: string,
    threadId: string,
    policy: SessionRemovePolicy,
    catalog: readonly Thread[],
    descendantIds: readonly string[],
  ): Promise<SessionRemoveResult> {
    const target = catalog.find(({ id }) => id === threadId);
    if (!target) throw new Error(`Pi session does not exist: ${threadId}`);
    const relatedIds = new Set([threadId, ...descendantIds]);
    const running = catalog.find((thread) => relatedIds.has(thread.id) && thread.running);
    if (running) throw new Error(`Cannot remove session tree while ${running.id} is running`);
    const removedIds = policy === "subtree" ? relatedIds : new Set([threadId]);
    for (const id of removedIds) this.assertNotActiveSubagent(projectId, id);
    const lockKeys = [...relatedIds].map((id) => workerKey(projectId, id)).sort();
    return this.withThreadLocks(lockKeys, async () => {
      this.assertProjectAvailable(projectId);
      const latestCatalog = await this.list(projectId);
      const latestRelatedIds = new Set([threadId, ...collectThreadDescendantIds(latestCatalog, threadId)]);
      if (latestRelatedIds.size !== relatedIds.size || [...latestRelatedIds].some((id) => !relatedIds.has(id))) {
        throw new Error("Session tree changed while deletion was starting; retry the operation");
      }
      const latestRunning = latestCatalog.find((thread) => latestRelatedIds.has(thread.id) && thread.running);
      if (latestRunning) throw new Error(`Cannot remove session tree while ${latestRunning.id} is running`);
      const records = [...latestRelatedIds].flatMap((id) => {
        const current = this.records.get(workerKey(projectId, id));
        return current ? [current] : [];
      });
      const busy = records.find((record) => record.inFlight > 0 || record.summary?.running);
      if (busy) throw new Error(`Cannot remove busy thread ${projectId}/${busy.threadId}`);
      for (const record of records) record.retired = true;
      await Promise.all(records.map((record) => this.awaitRecordShutdown(record)));
      for (const record of records) {
        const key = workerKey(record.projectId, record.threadId);
        if (this.records.get(key) === record) this.records.delete(key);
      }
      const result = await this.options.metadata.removeCold(
        projectId,
        this.options.getCwd(projectId),
        threadId,
        policy,
      );
      for (const id of result.removedThreadIds) this.clearCreationReservation(id);
      return result;
    });
  }

  /** 将子会话提升为 root：清除其 parentSession header，子树跟随目标上移，不删除任何会话。 */
  async promote(projectId: string, threadId: string): Promise<SessionRemoveResult> {
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    this.options.beginSubagentTreeMutation?.(projectId, threadId);
    try {
      return await this.promoteThread(projectId, threadId);
    } finally {
      this.options.endSubagentTreeMutation?.(projectId, threadId);
    }
  }

  private async promoteThread(projectId: string, threadId: string): Promise<SessionRemoveResult> {
    const catalog = await this.list(projectId);
    const target = catalog.find(({ id }) => id === threadId);
    if (!target) throw new Error(`Pi session does not exist: ${threadId}`);
    if (!target.parentThreadId) throw new Error(`Pi session is already a root session: ${threadId}`);
    if (target.running) throw new Error(`Cannot promote session while ${threadId} is running`);
    this.assertNotActiveSubagent(projectId, threadId);
    return this.withThreadLocks([workerKey(projectId, threadId)], async () => {
      this.assertProjectAvailable(projectId);
      const latestCatalog = await this.list(projectId);
      const latestTarget = latestCatalog.find(({ id }) => id === threadId);
      if (!latestTarget?.parentThreadId) {
        throw new Error("Session tree changed while promotion was starting; retry the operation");
      }
      if (latestTarget.running) throw new Error(`Cannot promote session while ${threadId} is running`);
      const record = this.records.get(workerKey(projectId, threadId));
      if (record && (record.inFlight > 0 || record.summary?.running)) {
        throw new Error(`Cannot promote busy thread ${projectId}/${threadId}`);
      }
      return this.options.metadata.promoteCold(projectId, this.options.getCwd(projectId), threadId);
    });
  }

  async removeProject(projectId: string): Promise<void> {
    this.assertProjectAvailable(projectId);
    this.drainingProjects.add(projectId);
    const activeOperations = [...this.operationTails.entries()]
      .filter(([key]) => key.startsWith(`${projectId}\0`))
      .map(([, operation]) => operation);
    await Promise.allSettled(activeOperations);
    const pendingCreations = [...this.pendingCreations.entries()]
      .filter(([key]) => key.startsWith(`${projectId}\0`))
      .map(([, creation]) => creation);
    await Promise.allSettled(pendingCreations);
    const pending = [...this.pending.entries()]
      .filter(([key]) => key.startsWith(`${projectId}\0`))
      .map(([, value]) => value);
    await Promise.allSettled(pending);
    const records = [...this.records.entries()].filter(([, record]) => record.projectId === projectId);
    for (const [, record] of records) record.retired = true;
    const shutdowns = await Promise.allSettled(records.map(([, record]) => this.awaitRecordShutdown(record)));
    const failure = shutdowns.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const [key, record] of records) {
      if (this.records.get(key) === record) this.records.delete(key);
    }
    for (const key of this.subagentAttachments.keys()) {
      if (key.startsWith(`${projectId}\0`)) this.subagentAttachments.delete(key);
    }
    await this.options.metadata.invalidateProject(projectId);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    clearInterval(this.idleTimer);
    await Promise.allSettled([
      ...this.pending.values(),
      ...this.pendingCreations.values(),
      ...this.extensionApplyCompletions.values(),
    ]);
    await this.capacityTail;
    const records = [...this.records.values()];
    for (const record of records) record.retired = true;
    const shutdowns = await Promise.allSettled(records.map((record) => this.awaitRecordShutdown(record)));
    const failure = shutdowns.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.records.clear();
    this.subagentAttachments.clear();
    this.exclusiveWorkspaceKeys.clear();
    this.exclusiveThreads.clear();
    for (const request of this.resourceReloadRequests.values()) {
      if (request.timer) clearTimeout(request.timer);
    }
    this.resourceReloadRequests.clear();
  }

  private async runWorkspaceExclusive<T>(
    projectId: string,
    threadId: string,
    operation: (record: WorkerRecord) => Promise<T>,
  ): Promise<T> {
    this.assertProjectAvailable(projectId);
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    const targetKey = workerKey(projectId, threadId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    this.assertNotActiveSubagent(projectId, threadId);
    this.exclusiveWorkspaceKeys.add(workspaceKey);
    let subagentBarrier = false;
    let releaseTerminalBarrier: (() => void) | undefined;
    try {
      this.options.beginSubagentWorkspaceMutation?.(workspaceKey);
      subagentBarrier = true;
      if (await this.hasPendingWorkerForWorkspace(workspaceKey)) {
        throw new Error("Cannot restore a checkpoint while a thread worker is starting");
      }
      const lockKeys = [
        ...new Set([
          targetKey,
          ...[...this.records.entries()]
            .filter(([, record]) => record.workspaceKey === workspaceKey && !record.retired)
            .map(([key]) => key),
        ]),
      ].sort();
      return await this.withThreadLocks(lockKeys, async () => {
        if (await this.hasPendingWorkerForWorkspace(workspaceKey)) {
          throw new Error("Cannot restore a checkpoint while a thread worker is starting");
        }
        const busyRecord = [...this.records.values()].find(
          (record) =>
            record.workspaceKey === workspaceKey && !record.retired && (record.inFlight > 0 || record.summary?.running),
        );
        if (busyRecord) {
          throw new Error(
            `Cannot restore a checkpoint while thread ${busyRecord.projectId}/${busyRecord.threadId} is busy`,
          );
        }

        releaseTerminalBarrier = await this.options.beginTerminalWorkspaceMutation?.(workspaceKey);
        const record = await this.requireUnlocked(projectId, threadId);
        if (record.workspaceKey !== workspaceKey) {
          throw new Error("Checkpoint worker resolved to a different workspace");
        }
        record.lastActivityAt = Date.now();
        record.inFlight += 1;
        this.cancelRequestedClose(record);
        try {
          return await operation(record);
        } catch (error) {
          if (isUnknownOutcome(error)) this.retireAfterUnknown(targetKey, record, error);
          throw error;
        } finally {
          record.inFlight -= 1;
          record.lastActivityAt = Date.now();
        }
      });
    } finally {
      this.requestRetireRequestedCloseIfIdle(targetKey);
      releaseTerminalBarrier?.();
      this.exclusiveWorkspaceKeys.delete(workspaceKey);
      if (subagentBarrier) this.options.endSubagentWorkspaceMutation?.(workspaceKey);
    }
  }

  private async runExclusive<T>(
    projectId: string,
    threadId: string,
    operation: (record: WorkerRecord) => Promise<T>,
  ): Promise<T> {
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    this.assertNotActiveSubagent(projectId, threadId);
    const key = workerKey(projectId, threadId);
    let record!: WorkerRecord;
    await this.withThreadLock(key, async () => {
      this.assertWorkspaceNotExclusive(workspaceKey);
      if (this.drainingThreads.has(key) || this.exclusiveThreads.has(key)) {
        throw new Error(`Cannot reload resources while thread ${projectId}/${threadId} is busy`);
      }
      record = await this.requireUnlocked(projectId, threadId);
      if (record.inFlight > 0 || record.summary?.running) {
        throw new Error(`Cannot reload resources while thread ${projectId}/${threadId} is busy`);
      }
      this.exclusiveThreads.add(key);
      record.lastActivityAt = Date.now();
      record.inFlight += 1;
      this.cancelRequestedClose(record);
    });
    try {
      return await operation(record);
    } catch (error) {
      if (isUnknownOutcome(error)) this.retireAfterUnknown(key, record, error);
      throw error;
    } finally {
      await this.withThreadLock(key, async () => {
        record.inFlight -= 1;
        record.lastActivityAt = Date.now();
        this.exclusiveThreads.delete(key);
      });
      this.requestRetireRequestedCloseIfIdle(key);
    }
  }

  private async use<T>(
    projectId: string,
    threadId: string,
    operation: (record: WorkerRecord) => Promise<T>,
    waitForExtensionApply = false,
  ): Promise<T> {
    const workspaceKey = await this.options.getWorkspaceKey(projectId);
    this.assertWorkspaceNotExclusive(workspaceKey);
    this.assertNotActiveSubagent(projectId, threadId);
    const key = workerKey(projectId, threadId);
    if (this.exclusiveThreads.has(key)) {
      throw new Error(`Thread ${projectId}/${threadId} is reloading resources`);
    }
    if (!waitForExtensionApply && this.drainingThreads.has(key)) {
      throw new Error(`Thread ${projectId}/${threadId} is applying extensions`);
    }
    let record!: WorkerRecord;
    while (true) {
      let applyCompletion: Promise<void> | undefined;
      await this.withThreadLock(key, async () => {
        this.assertWorkspaceNotExclusive(workspaceKey);
        applyCompletion = this.extensionApplyCompletions.get(key);
        if (waitForExtensionApply && applyCompletion) return;
        if (this.exclusiveThreads.has(key)) {
          throw new Error(`Thread ${projectId}/${threadId} is reloading resources`);
        }
        if (this.drainingThreads.has(key)) {
          throw new Error(`Thread ${projectId}/${threadId} is applying extensions`);
        }
        record = await this.requireUnlocked(projectId, threadId);
        record.lastActivityAt = Date.now();
        record.inFlight += 1;
        this.cancelRequestedClose(record);
      });
      if (!waitForExtensionApply || !applyCompletion) break;
      await applyCompletion;
    }
    try {
      return await operation(record);
    } catch (error) {
      if (isUnknownOutcome(error)) this.retireAfterUnknown(key, record, error);
      throw error;
    } finally {
      await this.withThreadLock(key, async () => {
        record.inFlight -= 1;
        record.lastActivityAt = Date.now();
      });
      this.requestRetireRequestedCloseIfIdle(key);
    }
  }

  private async requireUnlocked(projectId: string, threadId: string): Promise<WorkerRecord> {
    this.assertProjectAvailable(projectId);
    const key = workerKey(projectId, threadId);
    const current = this.records.get(key);
    if (current && !current.retired && current.client.available !== false) {
      current.lastActivityAt = Date.now();
      return current;
    }
    if (current) {
      current.retired = true;
      await this.awaitRecordShutdown(current);
      if (this.records.get(key) === current) this.records.delete(key);
    }
    const pending = this.pending.get(key);
    if (pending) {
      const record = await pending;
      if (record.retired || record.client.available === false) {
        await this.awaitRecordShutdown(record);
        if (this.records.get(key) === record) this.records.delete(key);
        return this.requireUnlocked(projectId, threadId);
      }
      return record;
    }
    const promise = this.open(projectId, threadId);
    this.pending.set(key, promise);
    try {
      const record = await promise;
      if (record.retired || record.client.available === false) {
        await this.awaitRecordShutdown(record);
        if (this.records.get(key) === record) this.records.delete(key);
        return this.requireUnlocked(projectId, threadId);
      }
      this.records.set(key, record);
      record.initialBootstrap = undefined;
      record.inFlight -= 1;
      return record;
    } finally {
      this.pending.delete(key);
    }
  }

  private async open(projectId: string, threadId: string): Promise<WorkerRecord> {
    const cwd = this.options.getCwd(projectId);
    const [threads, session] = await Promise.all([
      this.options.metadata.list(projectId, cwd),
      this.options.metadata.resolve(projectId, cwd, threadId),
    ]);
    const initialUpdatedAt = threads.find(({ id }) => id === threadId)?.updatedAt;
    const indexedThread = threads.find(({ id }) => id === threadId);
    const { set: extensionSet, allEntries } = await this.options.extensionSourcePolicy.resolveWithAll(projectId);
    const enabledPluginIds = indexedThread?.enabledPluginIds;
    return this.spawn({
      mode: "open",
      projectId,
      cwd,
      agentDir: this.options.agentDir,
      ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
      threadId,
      sessionFile: session.path,
      ...(initialUpdatedAt !== undefined ? { initialUpdatedAt } : {}),
      ...(enabledPluginIds ? { enabledPluginIds } : {}),
      extensionSet: buildSessionExtensionSet(extensionSet, allEntries, enabledPluginIds),
    });
  }

  private async validateOpenBinding(binding: ThreadWorkerSpawnBinding): Promise<ThreadWorkerBinding> {
    if (binding.mode === "create") return binding;
    const header = await readSessionFileHeader(binding.sessionFile, binding.projectId, binding.threadId);
    const cwd = await this.options.resolveSessionCwd(binding.projectId, header.cwd);
    return { ...binding, cwd, sessionFile: header.sessionFile, sessionHeaderCwd: header.cwd };
  }

  private persistMetadata(record: WorkerRecord, summary: Thread): Promise<void> {
    if (!record.sessionFile)
      throw new Error(`Session file is not materialized: ${record.projectId}/${record.threadId}`);
    const projectCwd = this.options.getCwd(record.projectId);
    const thread = withSessionEnabledPluginIds(record, summary);
    return samePath(record.cwd, projectCwd)
      ? this.options.metadata.upsert(record.projectId, projectCwd, record.sessionFile, thread)
      : this.options.metadata.registerExternal(record.projectId, projectCwd, record.sessionFile, thread);
  }

  private async spawn(input: ThreadWorkerSpawnBinding): Promise<WorkerRecord> {
    const binding = await this.validateOpenBinding(input);
    const blockedReason = this.blockedDevelopmentSets.get(binding.extensionSet.generation);
    if (blockedReason) {
      throw new Error(`Development extension set is blocked after repeated failures: ${blockedReason}`);
    }
    await this.reserveWorkerSlot();
    try {
      let lastError: unknown;
      const delays = binding.mode === "create" ? [0] : [0, 100, 500];
      for (const delayMs of delays) {
        if (delayMs > 0) await delay(delayMs);
        let browserSessionToken: string | undefined;
        try {
          browserSessionToken = this.options.registerBrowserSession?.(browserSessionIdentityOf(binding));
          const record = await this.spawnAttempt(binding, browserSessionToken);
          if (record.retired || record.client.available === false) {
            await this.awaitRecordShutdown(record);
            throw new Error(`Thread worker generation exited before registration: ${binding.projectId}`);
          }
          const key = workerKey(record.projectId, record.threadId);
          const current = this.records.get(key);
          if (current) {
            if (current.retired) {
              await this.awaitRecordShutdown(current);
              if (this.records.get(key) === current) this.records.delete(key);
            } else {
              record.retired = true;
              await this.awaitRecordShutdown(record);
              throw new Error(`Thread worker already exists for ${record.projectId}/${record.threadId}`);
            }
          }
          if (this.records.get(key)) {
            record.retired = true;
            await this.awaitRecordShutdown(record);
            throw new Error(`Thread worker already exists for ${record.projectId}/${record.threadId}`);
          }
          this.records.set(key, record);
          this.blockedDevelopmentSets.delete(binding.extensionSet.generation);
          return record;
        } catch (error) {
          if (browserSessionToken !== undefined) {
            this.options.revokeBrowserSession?.(browserSessionIdentityOf(binding), browserSessionToken);
          }
          if (isNonRetryableStartupError(error)) throw error;
          lastError = error;
        }
      }
      if (binding.extensionSet.entries.some((entry) => entry.source === "development")) {
        this.blockedDevelopmentSets.set(
          binding.extensionSet.generation,
          lastError instanceof Error ? lastError.message : String(lastError),
        );
      }
      throw lastError;
    } finally {
      await this.releaseWorkerSlot();
    }
  }

  private async spawnAttempt(binding: ThreadWorkerBinding, browserSessionToken?: string): Promise<WorkerRecord> {
    const workspaceKey = await this.options.getWorkspaceKey(binding.projectId);
    let record: WorkerRecord;
    let client: ThreadWorkerClient;
    const clientOptions: WorkerClientOptions = {
      manifest: this.options.manifest,
      binding: { role: "thread", value: binding },
      onStderr: (text) => this.options.log?.(`thread:${binding.projectId}`, text),
      onEvent: (event) => this.handleEvent(record, event),
      onHostRequest: this.options.handleHostRequest
        ? (request, emit) => {
            assertHostRequestIdentity(request, binding);
            return this.options.handleHostRequest!(request, emit);
          }
        : undefined,
      onFailure: (error) => {
        if (!record) return;
        this.unregisterClient(client);
        record.retired = true;
        const key = workerKey(record.projectId, record.threadId);
        if (this.records.get(key)?.client !== client) return;
        this.records.delete(key);
        if (record.extensionSet.entries.some((entry) => entry.source === "development")) {
          const now = Date.now();
          const previous = this.developmentCrashCounts.get(record.extensionSet.generation);
          const count = previous && now - previous.lastAt <= 60_000 ? previous.count + 1 : 1;
          this.developmentCrashCounts.set(record.extensionSet.generation, { count, lastAt: now });
          if (count >= 3) {
            this.blockedDevelopmentSets.set(record.extensionSet.generation, error.message);
          }
        }
        void this.options.hostWorkerFailed?.(record.projectId, record.threadId);
        if (!record.failureReported) {
          record.failureReported = true;
          this.options.failed(record.projectId, record.threadId, error);
        }
      },
      browserSessionToken,
    };
    client = this.options.createWorkerClient?.(clientOptions) ?? new SidecarWorkerClient(clientOptions);
    this.liveClients.set(client.instanceId, client);
    try {
      this.options.generationReferences?.retain(`thread:${client.instanceId}`, binding.extensionSet);
    } catch (error) {
      this.liveClients.delete(client.instanceId);
      if (browserSessionToken !== undefined) {
        this.options.revokeBrowserSession?.(browserSessionIdentityOf(binding), browserSessionToken);
      }
      await client.shutdown().catch(() => undefined);
      throw error;
    }
    record = {
      client,
      projectId: binding.projectId,
      threadId: binding.mode === "open" ? binding.threadId : "",
      cwd: binding.cwd,
      workspaceKey,
      lastActivityAt: Date.now(),
      inFlight: 1,
      attachments: 0,
      createRequestId: binding.mode === "create" ? binding.createInput.createRequestId : undefined,
      sessionFile: binding.mode === "open" ? binding.sessionFile : undefined,
      extensionSet: cloneExtensionSet(binding.extensionSet),
      ...(binding.mode === "create"
        ? binding.createInput.enabledPluginIds
          ? { enabledPluginIds: binding.createInput.enabledPluginIds }
          : {}
        : binding.enabledPluginIds
          ? { enabledPluginIds: binding.enabledPluginIds }
          : {}),
      desiredExtensionGeneration: binding.extensionSet.generation,
      desiredExtensionDiagnostics: binding.extensionSet.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      extensionDiagnostics: binding.extensionSet.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      browserSessionIdentity: browserSessionIdentityOf(binding),
      ...(browserSessionToken !== undefined ? { browserSessionToken } : {}),
      retired: false,
      closeRequested: false,
    };
    try {
      const ready = await client.ready();
      if (record.retired || client.available === false) {
        throw new Error(`Thread worker exited during startup: ${binding.projectId}`);
      }
      const bootstrap = ready.result as unknown as SessionBootstrap;
      if (!bootstrap?.threadId) throw new Error("Thread worker did not return a bootstrap");
      if (!samePath(binding.cwd, bootstrap.control.cwd)) {
        throw new Error(`Thread worker cwd mismatch: expected ${binding.cwd}, got ${bootstrap.control.cwd}`);
      }
      record.threadId = bootstrap.threadId;
      record.cwd = bootstrap.control.cwd;
      record.initialBootstrap = bootstrap;
      record.summary = summaryFromBootstrap(bootstrap);
      record.extensionDiagnostics = bootstrap.control.extensionSet.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        workerInstanceId: client.instanceId,
      }));
      if (record.sessionFile) {
        await this.persistMetadata(record, record.summary);
      }
      return record;
    } catch (error) {
      record.retired = true;
      await this.awaitRecordShutdown(record);
      throw error;
    }
  }

  private retireAfterUnknown(key: string, record: WorkerRecord, error: unknown): void {
    if (record.retired) return;
    record.retired = true;
    this.beginRecordShutdown(record);
    if (this.records.get(key) !== record || record.failureReported) return;
    record.failureReported = true;
    this.options.failed(record.projectId, record.threadId, error instanceof Error ? error : new Error(String(error)));
  }

  private async awaitRecordShutdown(record: WorkerRecord): Promise<void> {
    await this.beginRecordShutdown(record);
  }

  private beginRecordShutdown(record: WorkerRecord): Promise<void> {
    record.shutdownPromise ??= Promise.resolve()
      .then(() => {
        const token = record.browserSessionToken;
        record.browserSessionToken = undefined;
        if (token !== undefined) this.options.revokeBrowserSession?.(record.browserSessionIdentity, token);
      })
      .then(() => this.options.hostWorkerFailed?.(record.projectId, record.threadId))
      .then(() => record.client.shutdown())
      .finally(() => this.unregisterClient(record.client));
    return record.shutdownPromise;
  }

  private unregisterClient(client: ThreadWorkerClient): void {
    if (this.liveClients.get(client.instanceId) === client) this.liveClients.delete(client.instanceId);
    this.options.generationReferences?.release(`thread:${client.instanceId}`);
  }

  private handleEvent(record: WorkerRecord, event: SidecarEvent): void {
    if (record.retired) return;
    record.lastActivityAt = Date.now();
    if (event.event.type === "session-push") {
      let payload = event.event.payload;
      if (payload.type === "control") {
        record.extensionDiagnostics = payload.control.extensionSet.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          workerInstanceId: record.client.instanceId,
        }));
        payload = {
          ...payload,
          control: {
            ...payload.control,
            extensionSet: {
              ...payload.control.extensionSet,
              diagnostics: record.extensionDiagnostics.map((diagnostic) => ({ ...diagnostic })),
              reloadRequired: record.extensionSet.generation !== record.desiredExtensionGeneration,
            },
          },
        };
      }
      this.options.push(payload, event.workerInstanceId, event.sequence);
    } else if (event.event.type === "summary-changed") {
      record.summary = record.parentThreadId
        ? { ...event.event.summary, parentThreadId: record.parentThreadId }
        : event.event.summary;
      if (record.attachments === 0) this.options.catalogChanged?.({ ...record.summary });
      if (!record.summary.running) {
        this.requestCapacityTrim();
        this.requestRetireRequestedCloseIfIdle(workerKey(record.projectId, record.threadId));
      }
      if (!record.sessionFile) {
        record.client.acknowledge(event.sequence);
        return;
      }
      void this.persistMetadata(record, record.summary)
        .catch((error: unknown) => this.options.log?.(`metadata:${record.projectId}`, String(error)))
        .finally(() => record.client.acknowledge(event.sequence));
    } else if (event.event.type === "resync-required") {
      record.client.acknowledge(event.sequence);
      this.options.resync(record.projectId, record.threadId, event.event.reason);
    } else if (event.event.type === "session-materialized") {
      record.sessionFile = event.event.sessionFile;
      this.writeCreationReservation(
        event.event.projectId,
        this.options.getCwd(event.event.projectId),
        record.cwd,
        event.event.sessionId,
        record.createRequestId ?? "unknown",
        "materialized",
        event.event.sessionFile,
        event.workerInstanceId,
      );
      record.client.acknowledge(event.sequence);
    } else {
      record.client.acknowledge(event.sequence);
    }
  }

  private assertNotActiveSubagent(projectId: string, threadId: string): void {
    if (this.options.isActiveSubagentThread?.(projectId, threadId)) {
      throw new Error("Active subagent sessions are read-only in Desktop");
    }
  }

  private async hasPendingWorkerForWorkspace(workspaceKey: string): Promise<boolean> {
    const projectIds = new Set<string>();
    for (const key of [...this.pendingCreations.keys(), ...this.pending.keys()]) {
      const separator = key.indexOf("\0");
      if (separator !== -1) projectIds.add(key.slice(0, separator));
    }
    const workspaceKeys = await Promise.all(
      [...projectIds].map((projectId) => this.options.getWorkspaceKey(projectId)),
    );
    return workspaceKeys.includes(workspaceKey);
  }

  private assertWorkspaceNotExclusive(workspaceKey: string): void {
    if (this.exclusiveWorkspaceKeys.has(workspaceKey)) {
      throw new Error(`Workspace ${workspaceKey} is restoring a checkpoint`);
    }
  }

  private assertProjectAvailable(projectId: string): void {
    if (this.disposing) throw new Error("Desktop thread worker registry is shutting down");
    if (this.drainingProjects.has(projectId)) throw new Error(`Project ${projectId} is being removed`);
  }

  private async withThreadLocks<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const run = (index: number): Promise<T> => {
      const key = uniqueKeys[index];
      return key ? this.withThreadLock(key, () => run(index + 1)) : operation();
    };
    return run(0);
  }

  private async withThreadLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(key) === current) this.operationTails.delete(key);
    }
  }

  private async reserveWorkerSlot(): Promise<void> {
    await this.withCapacityLock(async () => {
      await this.ensureCapacity();
      this.reservedWorkerSlots += 1;
    });
  }

  private async releaseWorkerSlot(): Promise<void> {
    await this.withCapacityLock(async () => {
      this.reservedWorkerSlots -= 1;
    });
    this.requestCapacityTrim();
  }

  private async ensureCapacity(): Promise<void> {
    const maximum = this.options.maxLiveWorkers ?? DEFAULT_MAX_LIVE_WORKERS;
    if (this.records.size + this.reservedWorkerSlots < maximum) return;
    await this.evictLeastRecentlyUsedIdle();
  }

  private async trimToCapacity(): Promise<void> {
    await this.withCapacityLock(async () => {
      const maximum = this.options.maxLiveWorkers ?? DEFAULT_MAX_LIVE_WORKERS;
      while (this.records.size > maximum) {
        if (!(await this.evictLeastRecentlyUsedIdle())) return;
      }
    });
  }

  private requestCapacityTrim(): void {
    if (this.disposing) return;
    void this.trimToCapacity().catch((error: unknown) =>
      this.options.log?.("thread-capacity", error instanceof Error ? error.message : String(error)),
    );
  }

  private async evictLeastRecentlyUsedIdle(): Promise<boolean> {
    const candidate = [...this.records.entries()]
      .filter(
        ([, record]) =>
          !record.retired && !record.summary?.running && record.inFlight === 0 && record.attachments === 0,
      )
      .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt)[0];
    if (!candidate) return false;
    let evicted = false;
    await this.withThreadLock(candidate[0], async () => {
      if (
        this.records.get(candidate[0]) !== candidate[1] ||
        candidate[1].summary?.running ||
        candidate[1].inFlight > 0 ||
        candidate[1].attachments > 0
      ) {
        return;
      }
      candidate[1].retired = true;
      await this.awaitRecordShutdown(candidate[1]);
      if (this.records.get(candidate[0]) === candidate[1]) this.records.delete(candidate[0]);
      evicted = true;
    });
    return evicted;
  }

  private async evictIdle(): Promise<void> {
    if (this.evictionRunning) return;
    this.evictionRunning = true;
    try {
      await this.trimToCapacity();
      const cutoff = Date.now() - (this.options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
      const candidates = [...this.records.entries()].filter(
        ([, record]) =>
          !record.retired &&
          !record.summary?.running &&
          record.inFlight === 0 &&
          record.attachments === 0 &&
          record.lastActivityAt <= cutoff,
      );
      for (const [key, record] of candidates) {
        await this.withThreadLock(key, async () => {
          if (
            this.records.get(key) !== record ||
            record.summary?.running ||
            record.inFlight > 0 ||
            record.attachments > 0 ||
            record.lastActivityAt > cutoff
          ) {
            return;
          }
          record.retired = true;
          await this.awaitRecordShutdown(record);
          if (this.records.get(key) === record) this.records.delete(key);
        });
      }
    } finally {
      this.evictionRunning = false;
    }
  }

  private async recoverCreationRequest(
    projectId: string,
    createRequestId: string,
  ): Promise<SessionBootstrap | undefined> {
    const directory = join(this.options.userDataDir, "creation-reservations");
    if (!existsSync(directory)) return undefined;
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(directory, entry);
      let reservation: CreationReservation;
      try {
        reservation = JSON.parse(readFileSync(path, "utf8")) as CreationReservation;
      } catch {
        continue;
      }
      if (reservation.projectId !== projectId || reservation.createRequestId !== createRequestId) continue;
      const current = this.records.get(workerKey(projectId, reservation.sessionId));
      if (current) return current.client.request<SessionBootstrap>({ type: "bootstrap" }, 30_000);
      let recovery = await this.options.metadata.recoverCreationReservation(reservation);
      while (recovery.status === "active") {
        await delay(Math.max(1, recovery.retryAfterMs));
        recovery = await this.options.metadata.recoverCreationReservation(reservation);
      }
      if (recovery.status === "committed") {
        return this.use(projectId, reservation.sessionId, (record) =>
          record.client.request<SessionBootstrap>({ type: "bootstrap" }, 30_000),
        );
      }
      rmSync(path);
      return undefined;
    }
    return undefined;
  }

  private async reconcileCreationReservations(projectId: string): Promise<void> {
    const directory = join(this.options.userDataDir, "creation-reservations");
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(directory, entry);
      let reservation: CreationReservation;
      try {
        reservation = JSON.parse(readFileSync(path, "utf8")) as CreationReservation;
      } catch {
        continue;
      }
      if (reservation.projectId !== projectId || !reservation.sessionId) continue;
      if (this.records.has(workerKey(projectId, reservation.sessionId))) continue;
      const recovery = await this.options.metadata.recoverCreationReservation(reservation);
      if (recovery.status === "orphan") rmSync(path);
    }
  }

  private writeCreationReservation(
    projectId: string,
    projectCwd: string,
    cwd: string,
    sessionId: string,
    createRequestId: string,
    state: "reserved" | "materialized",
    sessionFile?: string,
    workerInstanceId?: string,
  ): void {
    const directory = join(this.options.userDataDir, "creation-reservations");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionId}.json`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          projectId,
          projectCwd,
          cwd,
          sessionId,
          createRequestId,
          state,
          sessionFile,
          workerInstanceId,
          updatedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    renameSync(temporary, path);
  }

  private clearCreationReservation(sessionId: string): void {
    const path = join(this.options.userDataDir, "creation-reservations", `${sessionId}.json`);
    if (existsSync(path)) rmSync(path);
  }

  private async withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.capacityTail;
    let release!: () => void;
    this.capacityTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isNonRetryableStartupError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Sidecar (?:runtime|protocol) mismatch|runtime compatibility|projection is missing|did not exit|fenc/i.test(
      error.message,
    )
  );
}

function isUnknownOutcome(error: unknown): error is SidecarRequestError {
  return error instanceof SidecarRequestError && error.code === "SIDECAR_MUTATION_UNKNOWN_OUTCOME";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertHostRequestIdentity(request: SubagentHostRequest, binding: ThreadWorkerBinding): void {
  const parentThreadId = binding.mode === "create" ? binding.sessionId : binding.threadId;
  const identity = request.type === "subagent.run" ? request.request : request;
  if (identity.projectId !== binding.projectId || identity.parentThreadId !== parentThreadId) {
    throw new Error("Subagent host request identity does not match the thread worker binding");
  }
}

/** 从 ThreadWorkerBinding 派生浏览器会话身份（与 sidecar 注入的 PI_BROWSER_SESSION_* 一致）。 */
export function browserSessionIdentityOf(binding: ThreadWorkerBinding): BrowserSessionIdentity {
  return {
    projectId: binding.projectId,
    threadId: binding.mode === "create" ? binding.sessionId : binding.threadId,
  };
}

function workerKey(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`;
}

function decorateBootstrap(record: WorkerRecord, bootstrap: SessionBootstrap): SessionBootstrap {
  return {
    ...bootstrap,
    control: {
      ...bootstrap.control,
      extensionSet: {
        ...bootstrap.control.extensionSet,
        diagnostics: record.extensionDiagnostics.map((diagnostic) => ({ ...diagnostic })),
        reloadRequired: record.extensionSet.generation !== record.desiredExtensionGeneration,
      },
    },
  };
}

function activateAppliedRecord(record: WorkerRecord, attachments: number): void {
  record.attachments = attachments;
  record.initialBootstrap = undefined;
  record.inFlight = Math.max(0, record.inFlight - 1);
}

async function waitForIdleSummary(record: WorkerRecord): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = await record.client.request<Thread>({ type: "getSummary", archived: false }, 10_000);
    record.summary = summary;
    if (!summary.running) return;
    await delay(50);
  }
  throw new Error("Thread did not become idle after abort");
}

function cloneExtensionSet(set: ResolvedExtensionSet): ResolvedExtensionSet {
  return {
    ...set,
    entries: set.entries.map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities],
      ...(entry.configuration ? { configuration: { ...entry.configuration } } : {}),
    })),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

/** 索引持久化时把会话级插件子集合入 summary，避免后续 summary 推送覆盖丢失。 */
function withSessionEnabledPluginIds(record: WorkerRecord, summary: Thread): Thread {
  return record.enabledPluginIds ? { ...summary, enabledPluginIds: record.enabledPluginIds } : summary;
}

/** 两个字符串列表是否相等（顺序无关）。 */
function equalStringLists(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

/** 会话级激活子集过滤：builtin/curated 恒加载（来自项目扩展集），marketplace/development 按选中集从全量条目重建（含项目作用域外插件）；generation 不变。 */
function buildSessionExtensionSet(
  set: ResolvedExtensionSet,
  allEntries: ResolvedExtensionEntry[],
  enabledPluginIds: string[] | undefined,
): ResolvedExtensionSet {
  if (!enabledPluginIds) return set;
  const selected = new Set(enabledPluginIds);
  const outOfScope = allEntries.filter(
    (entry) => selected.has(entry.id) && !set.entries.some((active) => active.id === entry.id),
  );
  const entries = [
    ...set.entries.filter((entry) => {
      if (entry.source === "marketplace" || entry.source === "development") return selected.has(entry.id);
      return true;
    }),
    ...outOfScope,
  ];
  return {
    ...set,
    entries: entries.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] })),
  };
}

function summaryFromBootstrap(bootstrap: SessionBootstrap): Thread {
  const nodes = bootstrap.timeline.nodes.filter((node) => node.kind === "user" || node.kind === "assistant");
  const lastNode = nodes.at(-1);
  const lastUser = lastNode ? [...nodes].reverse().find((node) => node.kind === "user") : undefined;
  const nodeText = (node: (typeof nodes)[number]) =>
    node.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const firstUser = nodes.find((node) => node.kind === "user");
  const preview = firstUser?.kind === "user" ? nodeText(firstUser).slice(0, 120) : "";
  const lastUserPreview = lastUser ? previewFirstLines(nodeText(lastUser), THREAD_USER_PREVIEW_MAX_CHARS) : undefined;
  const lastAssistantPreview =
    lastNode?.kind === "assistant" ? previewFirstLines(nodeText(lastNode), THREAD_ASSISTANT_PREVIEW_MAX_CHARS) : "";
  return {
    id: bootstrap.threadId,
    projectId: bootstrap.projectId,
    title: bootstrap.control.title,
    createdAt: nodes[0]?.createdAt ?? Date.now(),
    updatedAt: bootstrap.control.updatedAt,
    messageCount: nodes.length,
    preview,
    ...(lastUserPreview !== undefined ? { lastUserPreview } : {}),
    lastAssistantPreview,
    archived: false,
    running: bootstrap.timeline.phase !== "idle",
  };
}
