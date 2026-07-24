import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  SessionPromptInput,
  SessionPushPayload,
  SessionReloadInput,
  Thread,
} from "../../shared/contracts.ts";
import type {
  ApplyDesktopExtensionSetResult,
  DesktopExtensionDiagnostic,
  ResolvedExtensionSet,
  StaleDraftExtensionSetErrorDetails,
} from "../../shared/desktop-extension-contracts.ts";
import type { CreationReservation, SidecarEvent, ThreadWorkerBinding } from "../../shared/sidecar-contracts.ts";
import type { SubagentHostRequest, SubagentRunEvent } from "../../shared/subagent-contracts.ts";
import type { DesktopExtensionSourcePolicy } from "../extensions/desktop-extension-source-policy.ts";
import type { MetadataWorkerClient } from "./metadata-worker-client.ts";
import type { NodeRuntimeManifest } from "./node-runtime-locator.ts";
import { SidecarRequestError, SidecarWorkerClient, type WorkerClientOptions } from "./worker-client.ts";

export interface ThreadWorkerClient {
  readonly instanceId: string;
  readonly available?: boolean;
  ready(): ReturnType<SidecarWorkerClient["ready"]>;
  request<T>(command: Parameters<SidecarWorkerClient["request"]>[0], timeoutMs?: number | null): Promise<T>;
  acknowledge(sequence: number): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

interface WorkerRecord {
  client: ThreadWorkerClient;
  projectId: string;
  threadId: string;
  summary?: Thread;
  initialBootstrap?: SessionBootstrap;
  lastActivityAt: number;
  inFlight: number;
  attachments: number;
  createRequestId?: string;
  sessionFile?: string;
  extensionSet: ResolvedExtensionSet;
  desiredExtensionGeneration: string;
  desiredExtensionDiagnostics: DesktopExtensionDiagnostic[];
  extensionDiagnostics: DesktopExtensionDiagnostic[];
  retired: boolean;
  shutdownPromise?: Promise<void>;
  failureReported?: boolean;
}

export interface ThreadWorkerRegistryOptions {
  manifest: NodeRuntimeManifest;
  metadata: MetadataWorkerClient;
  userDataDir: string;
  agentDir: string;
  extensionSourcePolicy: DesktopExtensionSourcePolicy;
  getCwd(projectId: string): string;
  push(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void;
  failed(projectId: string, threadId: string, error: Error): void;
  resync(projectId: string, threadId: string, reason: string): void;
  log?(scope: string, text: string): void;
  handleHostRequest?(request: SubagentHostRequest, emit: (event: SubagentRunEvent) => void): Promise<unknown>;
  hostWorkerFailed?(projectId: string, threadId: string): Promise<void>;
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
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly drainingThreads = new Set<string>();
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
    const intervalMs = Math.max(1_000, Math.min(options.idleTtlMs ?? 30 * 60_000, 60_000));
    this.idleTimer = setInterval(() => void this.evictIdle(), intervalMs);
    this.idleTimer.unref();
  }

  async list(projectId: string): Promise<Thread[]> {
    this.assertProjectAvailable(projectId);
    const cwd = this.options.getCwd(projectId);
    const catalog = new Map((await this.options.metadata.list(projectId, cwd)).map((thread) => [thread.id, thread]));
    for (const record of this.records.values()) {
      if (record.projectId !== projectId || record.retired || !record.summary) continue;
      catalog.set(record.threadId, record.summary);
    }
    await this.reconcileCreationReservations(projectId);
    return [...catalog.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  acknowledge(workerInstanceId: string, sidecarSequence: number): void {
    this.liveClients.get(workerInstanceId)?.acknowledge(sidecarSequence);
  }

  async getDraftConfig(projectId: string): Promise<DraftSessionConfig> {
    this.assertProjectAvailable(projectId);
    const cwd = this.options.getCwd(projectId);
    const extensionSet = await this.options.extensionSourcePolicy.resolve(projectId);
    return this.options.metadata.getDraftConfig(projectId, cwd, extensionSet);
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
    const recovered = await this.recoverCreationRequest(input.projectId, input.createRequestId);
    if (recovered) return recovered;
    const cwd = this.options.getCwd(input.projectId);
    const extensionSet = await this.options.extensionSourcePolicy.resolve(input.projectId);
    if (input.extensionSetGeneration !== extensionSet.generation) {
      throw new StaleDraftExtensionSetError(input.extensionSetGeneration, extensionSet.generation);
    }
    this.assertProjectAvailable(input.projectId);
    const sessionId = randomUUID();
    this.writeCreationReservation(input.projectId, cwd, sessionId, input.createRequestId, "reserved", undefined);
    const binding: ThreadWorkerBinding = {
      mode: "create",
      projectId: input.projectId,
      cwd,
      agentDir: this.options.agentDir,
      sessionId,
      createInput: input,
      extensionSet,
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
    record.summary = summaryFromBootstrap(bootstrap);
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
    const bootstrap = await this.use(projectId, threadId, async (record) => {
      const result = await record.client.request<SessionBootstrap>({ type: "bootstrap" }, 30_000);
      record.attachments += 1;
      return decorateBootstrap(record, result);
    });
    return bootstrap;
  }

  /** 仅确保 thread worker 已冷启并驻留在 records 中，不建立 attachment 或返回 bootstrap。 */
  prewarm(projectId: string, threadId: string): Promise<void> {
    return this.use(projectId, threadId, async () => undefined);
  }

  detach(projectId: string, threadId: string): void {
    const record = this.records.get(workerKey(projectId, threadId));
    if (record && record.attachments > 0) record.attachments -= 1;
  }

  async prompt(input: SessionPromptInput): Promise<SessionCommandResult> {
    return this.use(input.projectId, input.threadId, (record) =>
      record.client.request({ type: "prompt", input }, null),
    );
  }

  async edit(input: SessionEditInput): Promise<SessionCommandResult> {
    return this.use(input.projectId, input.threadId, (record) => record.client.request({ type: "edit", input }, null));
  }

  async reload(input: SessionReloadInput): Promise<SessionCommandResult> {
    return this.use(input.projectId, input.threadId, (record) =>
      record.client.request({ type: "reload", input }, null),
    );
  }

  async branch(input: SessionBranchInput): Promise<SessionBranchResult> {
    const result = await this.use(input.projectId, input.threadId, (record) =>
      record.client.request<SessionBranchResult>({ type: "branch", input }, null),
    );
    return result;
  }

  async cancel(projectId: string, threadId: string): Promise<void> {
    await this.use(projectId, threadId, (record) => record.client.request({ type: "cancel" }, null));
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
    const key = workerKey(projectId, threadId);
    if (this.drainingThreads.has(key))
      throw new Error(`Extension set apply is already running for ${projectId}/${threadId}`);
    this.drainingThreads.add(key);
    try {
      return await this.withThreadLock(key, async () => {
        const current = await this.requireUnlocked(projectId, threadId);
        const desired = await this.options.extensionSourcePolicy.resolve(projectId);
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
            threadId,
            sessionFile,
            extensionSet: desired,
          });
          latestDesired = await this.options.extensionSourcePolicy.resolve(projectId);
          if (latestDesired.generation !== expectedDesiredGeneration) {
            throw new StaleExtensionSetApplyError(expectedDesiredGeneration, latestDesired.generation);
          }
          activateAppliedRecord(replacement, attachments);
          this.options.resync(projectId, threadId, "extension-set-applied");
          return { status: "applied", generation: desired.generation };
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
      });
    } finally {
      this.drainingThreads.delete(key);
    }
  }

  async respond(projectId: string, threadId: string, response: HostResponse): Promise<void> {
    const key = workerKey(projectId, threadId);
    let record!: WorkerRecord;
    await this.withThreadLock(key, async () => {
      const current = this.records.get(key);
      if (!current) throw new Error("Host UI response targets an unavailable thread worker");
      if (response.workerInstanceId && response.workerInstanceId !== current.client.instanceId) {
        throw new Error("Host UI response targets a stale thread worker generation");
      }
      record = current;
      record.inFlight += 1;
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
    }
  }

  async rename(projectId: string, threadId: string, title: string): Promise<void> {
    await this.withThreadLock(workerKey(projectId, threadId), async () => {
      this.assertProjectAvailable(projectId);
      const current = this.records.get(workerKey(projectId, threadId));
      if (current) {
        try {
          await current.client.request({ type: "rename", title }, 30_000);
          current.summary = await current.client.request<Thread>({ type: "getSummary", archived: false }, 30_000);
          if (current.sessionFile) {
            await this.options.metadata.upsert(
              projectId,
              this.options.getCwd(projectId),
              current.sessionFile,
              current.summary,
            );
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

  async remove(projectId: string, threadId: string): Promise<void> {
    const key = workerKey(projectId, threadId);
    await this.withThreadLock(key, async () => {
      this.assertProjectAvailable(projectId);
      const current = this.records.get(key);
      if (current) {
        if (current.inFlight > 0) throw new Error(`Cannot remove busy thread ${projectId}/${threadId}`);
        current.retired = true;
        await this.awaitRecordShutdown(current);
        if (this.records.get(key) === current) this.records.delete(key);
      }
      await this.options.metadata.removeCold(projectId, this.options.getCwd(projectId), threadId);
      this.clearCreationReservation(threadId);
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
    await this.options.metadata.invalidateProject(projectId);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    clearInterval(this.idleTimer);
    await Promise.allSettled([...this.pending.values(), ...this.pendingCreations.values()]);
    await this.capacityTail;
    const records = [...this.records.values()];
    for (const record of records) record.retired = true;
    const shutdowns = await Promise.allSettled(records.map((record) => this.awaitRecordShutdown(record)));
    const failure = shutdowns.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.records.clear();
  }

  private async use<T>(
    projectId: string,
    threadId: string,
    operation: (record: WorkerRecord) => Promise<T>,
  ): Promise<T> {
    const key = workerKey(projectId, threadId);
    if (this.drainingThreads.has(key)) throw new Error(`Thread ${projectId}/${threadId} is applying extensions`);
    let record!: WorkerRecord;
    await this.withThreadLock(key, async () => {
      record = await this.requireUnlocked(projectId, threadId);
      record.lastActivityAt = Date.now();
      record.inFlight += 1;
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
      });
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
    const session = await this.options.metadata.resolve(projectId, cwd, threadId);
    const extensionSet = await this.options.extensionSourcePolicy.resolve(projectId);
    return this.spawn({
      mode: "open",
      projectId,
      cwd,
      agentDir: this.options.agentDir,
      threadId,
      sessionFile: session.path,
      extensionSet,
    });
  }

  private async spawn(binding: ThreadWorkerBinding): Promise<WorkerRecord> {
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
        try {
          const record = await this.spawnAttempt(binding);
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

  private async spawnAttempt(binding: ThreadWorkerBinding): Promise<WorkerRecord> {
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
    };
    client = this.options.createWorkerClient?.(clientOptions) ?? new SidecarWorkerClient(clientOptions);
    this.liveClients.set(client.instanceId, client);
    record = {
      client,
      projectId: binding.projectId,
      threadId: binding.mode === "open" ? binding.threadId : "",
      lastActivityAt: Date.now(),
      inFlight: 1,
      attachments: 0,
      createRequestId: binding.mode === "create" ? binding.createInput.createRequestId : undefined,
      sessionFile: binding.mode === "open" ? binding.sessionFile : undefined,
      extensionSet: cloneExtensionSet(binding.extensionSet),
      desiredExtensionGeneration: binding.extensionSet.generation,
      desiredExtensionDiagnostics: binding.extensionSet.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      extensionDiagnostics: binding.extensionSet.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      retired: false,
    };
    try {
      const ready = await client.ready();
      if (record.retired || client.available === false) {
        throw new Error(`Thread worker exited during startup: ${binding.projectId}`);
      }
      const bootstrap = ready.result as unknown as SessionBootstrap;
      if (!bootstrap?.threadId) throw new Error("Thread worker did not return a bootstrap");
      record.threadId = bootstrap.threadId;
      record.initialBootstrap = bootstrap;
      record.summary = summaryFromBootstrap(bootstrap);
      record.extensionDiagnostics = bootstrap.control.extensionSet.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        workerInstanceId: client.instanceId,
      }));
      if (record.sessionFile) {
        await this.options.metadata.upsert(
          record.projectId,
          this.options.getCwd(record.projectId),
          record.sessionFile,
          record.summary,
        );
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
      .then(() => this.options.hostWorkerFailed?.(record.projectId, record.threadId))
      .then(() => record.client.shutdown())
      .finally(() => this.unregisterClient(record.client));
    return record.shutdownPromise;
  }

  private unregisterClient(client: ThreadWorkerClient): void {
    if (this.liveClients.get(client.instanceId) === client) this.liveClients.delete(client.instanceId);
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
      record.summary = event.event.summary;
      if (!record.sessionFile) {
        record.client.acknowledge(event.sequence);
        return;
      }
      void this.options.metadata
        .upsert(record.projectId, this.options.getCwd(record.projectId), record.sessionFile, record.summary)
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

  private assertProjectAvailable(projectId: string): void {
    if (this.disposing) throw new Error("Desktop thread worker registry is shutting down");
    if (this.drainingProjects.has(projectId)) throw new Error(`Project ${projectId} is being removed`);
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
  }

  private async ensureCapacity(): Promise<void> {
    const maximum = this.options.maxLiveWorkers ?? 12;
    if (this.records.size + this.reservedWorkerSlots < maximum) return;
    const candidate = [...this.records.entries()]
      .filter(
        ([, record]) =>
          !record.retired && !record.summary?.running && record.inFlight === 0 && record.attachments === 0,
      )
      .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt)[0];
    if (!candidate) throw new Error(`All ${maximum} Desktop thread workers are busy`);
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
    });
    if (this.records.size + this.reservedWorkerSlots >= maximum) {
      throw new Error(`All ${maximum} Desktop thread workers are busy`);
    }
  }

  private async evictIdle(): Promise<void> {
    if (this.evictionRunning) return;
    this.evictionRunning = true;
    try {
      const cutoff = Date.now() - (this.options.idleTtlMs ?? 30 * 60_000);
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
      const recovery = await this.options.metadata.recoverCreationReservation(reservation);
      if (recovery.status === "active") {
        throw new Error("Session creation has an unknown outcome while its previous writer is still active");
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
  if (!(error instanceof Error)) return false;
  return /Sidecar (?:runtime|protocol) mismatch|runtime compatibility|projection is missing|did not exit|fenc/i.test(
    error.message,
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
    entries: set.entries.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] })),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function summaryFromBootstrap(bootstrap: SessionBootstrap): Thread {
  const nodes = bootstrap.timeline.nodes.filter((node) => node.kind === "user" || node.kind === "assistant");
  const firstUser = nodes.find((node) => node.kind === "user");
  const preview =
    firstUser?.kind === "user"
      ? firstUser.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .slice(0, 120)
      : "";
  return {
    id: bootstrap.threadId,
    projectId: bootstrap.projectId,
    title: bootstrap.control.title,
    createdAt: nodes[0]?.createdAt ?? Date.now(),
    updatedAt: bootstrap.control.updatedAt,
    messageCount: nodes.length,
    preview,
    archived: false,
    running: bootstrap.timeline.phase !== "idle",
  };
}
