import { closeSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { JsonValue, SessionBootstrap, SessionPushPayload, Thread } from "../../shared/contracts.ts";
import type { ModelConfigurationRevision, SidecarEvent } from "../../shared/sidecar-contracts.ts";
import type {
  SubagentHostRequest,
  SubagentRunEvent,
  SubagentRunRequest,
  SubagentWorkerBinding,
} from "../../shared/subagent-contracts.ts";
import type { SidecarRuntimeManifest } from "./sidecar-runtime-manifest.ts";
import { SidecarWorkerClient, type WorkerClientOptions } from "./worker-client.ts";

export interface SubagentWorkerClient {
  readonly instanceId: string;
  readonly available?: boolean;
  ready(): ReturnType<SidecarWorkerClient["ready"]>;
  request<T>(command: Parameters<SidecarWorkerClient["request"]>[0], timeoutMs?: number | null): Promise<T>;
  acknowledge(sequence: number): void;
  fail(error: Error): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

interface SubagentWorkerRecord {
  key: string;
  workspaceKey: string;
  request: SubagentRunRequest;
  client: SubagentWorkerClient;
  emit(event: SubagentRunEvent): void;
  catalogThread?: Thread;
  initialPromptObserved: boolean;
  /** Latest child session file, announced after a fresh session materializes. */
  liveSessionFile?: string;
  metadataTail: Promise<void>;
  metadataFailure?: Error;
  finalizePromise?: Promise<void>;
  failure?: Error;
  protocolFailure?: Error;
  terminalEvent?: Extract<SubagentRunEvent, { type: "completed" | "failed" }>;
}

export interface SubagentWorkerRegistryOptions {
  manifest: SidecarRuntimeManifest;
  agentDir: string;
  shellPath?: string;
  getWorkspaceKey?(projectId: string): Promise<string>;
  log?(scope: string, text: string): void;
  createWorkerClient?(options: WorkerClientOptions): SubagentWorkerClient;
  catalogChanged?(thread: Thread): void;
  persistSession?(projectId: string, sessionFile: string, thread: Thread): Promise<void>;
  push?(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void;
  resync?(projectId: string, threadId: string, reason: string): void;
  maxWorkers?: number;
  maxWorkersPerThread?: number;
}

/** Main-owned lifecycle registry for programmatic subagent sidecars. */
export class SubagentWorkerRegistry {
  private readonly options: SubagentWorkerRegistryOptions;
  private readonly records = new Map<string, SubagentWorkerRecord>();
  private readonly blockedWorkspaces = new Set<string>();
  private readonly blockedProjects = new Set<string>();
  private readonly blockedParentThreads = new Set<string>();
  private disposing = false;

  constructor(options: SubagentWorkerRegistryOptions) {
    this.options = options;
  }

  beginWorkspaceMutation(workspaceKey: string): void {
    if (this.blockedWorkspaces.has(workspaceKey)) throw new Error("Workspace mutation is already in progress");
    if ([...this.records.values()].some((record) => record.workspaceKey === workspaceKey)) {
      throw new Error("Cannot mutate a workspace while a subagent is running");
    }
    this.blockedWorkspaces.add(workspaceKey);
  }

  endWorkspaceMutation(workspaceKey: string): void {
    this.blockedWorkspaces.delete(workspaceKey);
  }

  beginProjectMutation(projectId: string): void {
    if (this.blockedProjects.has(projectId)) throw new Error("Project mutation is already in progress");
    if ([...this.records.values()].some((record) => record.request.projectId === projectId)) {
      throw new Error("Cannot mutate a project while a subagent is running");
    }
    this.blockedProjects.add(projectId);
  }

  endProjectMutation(projectId: string): void {
    this.blockedProjects.delete(projectId);
  }

  beginThreadMutation(projectId: string, parentThreadId: string): void {
    const key = parentThreadKey(projectId, parentThreadId);
    if (this.blockedParentThreads.has(key)) throw new Error("Session tree mutation is already in progress");
    if (
      [...this.records.values()].some(
        (record) => record.request.projectId === projectId && recordUsesParentSession(record, parentThreadId),
      )
    ) {
      throw new Error("Cannot mutate a session tree while a subagent is running");
    }
    this.blockedParentThreads.add(key);
  }

  endThreadMutation(projectId: string, parentThreadId: string): void {
    this.blockedParentThreads.delete(parentThreadKey(projectId, parentThreadId));
  }

  async handleHostRequest(request: SubagentHostRequest, emit: (event: SubagentRunEvent) => void): Promise<unknown> {
    switch (request.type) {
      case "subagent.run":
        return this.run(request.request, emit);
      case "subagent.cancel":
        await this.cancel(request.projectId, request.parentThreadId, request.runId, request.childIndex);
        return null;
      case "subagent.steer":
        await this.steer(request.projectId, request.parentThreadId, request.runId, request.childIndex, request.message);
        return null;
    }
  }

  listThreads(projectId: string): Thread[] {
    return [...this.records.values()].flatMap((record) =>
      record.request.projectId === projectId && record.catalogThread ? [{ ...record.catalogThread }] : [],
    );
  }

  isActiveThread(projectId: string, threadId: string): boolean {
    return this.recordForThread(projectId, threadId) !== undefined;
  }

  async attach(projectId: string, threadId: string): Promise<SessionBootstrap | undefined> {
    const record = this.recordForThread(projectId, threadId);
    if (!record) return undefined;
    if (record.metadataFailure) {
      throw new Error(`Subagent session handoff is blocked: ${record.metadataFailure.message}`);
    }
    return record.client.request<SessionBootstrap>({ type: "subagentBootstrap" }, 30_000);
  }

  async cancelActiveThread(projectId: string, threadId: string): Promise<void> {
    const record = this.recordForThread(projectId, threadId);
    if (!record) return;
    try {
      await record.client.request({ type: "subagentCancel", runId: record.request.runId }, 10_000);
    } catch (error) {
      if (record.terminalEvent || record.failure || this.records.get(record.key) !== record) return;
      throw error;
    }
  }

  acknowledge(workerInstanceId: string, sequence: number): boolean {
    const record = [...this.records.values()].find(({ client }) => client.instanceId === workerInstanceId);
    if (!record) return false;
    record.client.acknowledge(sequence);
    return true;
  }

  async refreshAllModels(revision: ModelConfigurationRevision): Promise<void> {
    const records = [...this.records.values()];
    const results = await Promise.allSettled(
      records.map((record) => record.client.request({ type: "refreshModelConfiguration", revision })),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            new Error(
              `Subagent model refresh failed for ${records[index]?.request.runId}/${
                records[index]?.request.childIndex
              }: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              { cause: result.reason },
            ),
          ]
        : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "One or more subagent workers failed to refresh models");
  }

  async cancelThread(projectId: string, parentThreadId: string): Promise<void> {
    const records = [...this.records.values()].filter(
      ({ request }) => request.projectId === projectId && request.parentThreadId === parentThreadId,
    );
    await Promise.allSettled(records.map((record) => this.finalizeRecord(record, "parent-thread-unavailable", 5_000)));
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const records = [...this.records.values()];
    await Promise.allSettled(records.map((record) => this.finalizeRecord(record)));
    this.records.clear();
    this.blockedWorkspaces.clear();
    this.blockedProjects.clear();
  }

  private async run(
    request: SubagentRunRequest,
    emit: (event: SubagentRunEvent) => void,
    parent?: SubagentWorkerRecord,
  ): Promise<JsonValue> {
    if (this.disposing) throw new Error("Desktop subagent worker registry is shutting down");
    const workspaceKey = await (this.options.getWorkspaceKey?.(request.projectId) ??
      Promise.resolve(request.projectId));
    if (this.blockedWorkspaces.has(workspaceKey)) {
      throw new Error("Cannot start a subagent while its workspace is being mutated");
    }
    if (this.blockedProjects.has(request.projectId)) {
      throw new Error("Cannot start a subagent while its project is being mutated");
    }
    const effectiveParentSessionId = request.parentSessionId ?? request.parentThreadId;
    if (
      this.blockedParentThreads.has(parentThreadKey(request.projectId, request.parentThreadId)) ||
      this.blockedParentThreads.has(parentThreadKey(request.projectId, effectiveParentSessionId))
    ) {
      throw new Error("Cannot start a subagent while its parent session tree is being mutated");
    }
    validateRunRequest(request);
    if (parent) validateNestedRequest(parent.request, request);
    else validateRootRequest(request);
    const key = workerKey(request.projectId, request.parentThreadId, request.runId, request.childIndex);
    if (this.records.has(key)) throw new Error(`Duplicate subagent run: ${request.runId}/${request.childIndex}`);
    this.assertCapacity(request.projectId, request.parentThreadId);

    const binding: SubagentWorkerBinding = {
      projectId: request.projectId,
      parentThreadId: request.parentThreadId,
      runId: request.runId,
      childIndex: request.childIndex,
      agentDir: this.options.agentDir,
      ...(this.options.shellPath ? { shellPath: this.options.shellPath } : {}),
    };
    let record!: SubagentWorkerRecord;
    const clientOptions: WorkerClientOptions = {
      manifest: this.options.manifest,
      binding: { role: "subagent", value: binding },
      onStderr: (text) => this.options.log?.(`subagent:${request.runId}:${request.childIndex}`, text),
      onEvent: (event) => this.handleEvent(record, event),
      onFailure: (error) => {
        if (record) record.failure = error;
      },
      onHostRequest: (hostRequest, nestedEmit) => this.handleNestedHostRequest(record, hostRequest, nestedEmit),
    };
    const client = this.options.createWorkerClient?.(clientOptions) ?? new SidecarWorkerClient(clientOptions);
    if (this.blockedWorkspaces.has(workspaceKey)) {
      await client.shutdown().catch(() => undefined);
      throw new Error("Cannot start a subagent while its workspace is being mutated");
    }
    record = {
      key,
      workspaceKey,
      request,
      client,
      emit,
      initialPromptObserved: false,
      metadataTail: Promise.resolve(),
    };
    this.records.set(key, record);
    try {
      try {
        await client.ready();
        const result = await client.request<JsonValue>({ type: "subagentRun", request }, null);
        if (record.failure) throw record.failure;
        if (record.metadataFailure) throw record.metadataFailure;
        return result;
      } catch (error) {
        if (record.protocolFailure) throw record.protocolFailure;
        if (record.metadataFailure) throw record.metadataFailure;
        if (record.terminalEvent?.type === "completed") {
          return {
            status: "completed",
            ...(record.terminalEvent.sessionFile ? { sessionFile: record.terminalEvent.sessionFile } : {}),
          };
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        const terminalEvent =
          record.terminalEvent?.type === "failed"
            ? record.terminalEvent
            : {
                type: "failed" as const,
                runId: request.runId,
                error: record.failure?.message ?? failure.message,
                ...(record.liveSessionFile ? { sessionFile: record.liveSessionFile } : {}),
              };
        if (!record.terminalEvent) {
          record.terminalEvent = terminalEvent;
          this.projectCatalogEvent(record, terminalEvent);
          record.emit(terminalEvent);
        }
        return {
          status: "failed",
          error: terminalEvent.error,
          ...(terminalEvent.sessionFile ? { sessionFile: terminalEvent.sessionFile } : {}),
        };
      }
    } finally {
      await this.cancelDescendants(record);
      await this.finalizeRecord(record, "subagent-writer-completed");
    }
  }

  private async handleNestedHostRequest(
    parent: SubagentWorkerRecord,
    request: SubagentHostRequest,
    emit: (event: SubagentRunEvent) => void,
  ): Promise<unknown> {
    if (!parent || this.records.get(parent.key) !== parent) {
      throw new Error("Parent subagent worker is no longer active");
    }
    if (!parent.request.extensionProfile.includes("fanout")) {
      throw new Error("Parent subagent worker is not authorized for nested fanout");
    }
    if (request.type === "subagent.run") return this.run(request.request, emit, parent);
    const target = this.requireRecord(request.projectId, request.parentThreadId, request.runId, request.childIndex);
    validateDirectChild(parent.request, target.request);
    if (request.type === "subagent.cancel") {
      await this.cancel(request.projectId, request.parentThreadId, request.runId, request.childIndex);
      return null;
    }
    await this.steer(request.projectId, request.parentThreadId, request.runId, request.childIndex, request.message);
    return null;
  }

  private async cancelDescendants(parent: SubagentWorkerRecord): Promise<void> {
    const descendants = [...this.records.values()].filter(
      (record) => record !== parent && isDescendant(parent.request, record.request),
    );
    await Promise.allSettled(
      descendants.map((record) => this.finalizeRecord(record, "parent-subagent-completed", 5_000)),
    );
  }

  private async cancel(projectId: string, parentThreadId: string, runId: string, childIndex: number): Promise<void> {
    const record = this.requireRecord(projectId, parentThreadId, runId, childIndex);
    await record.client.request({ type: "subagentCancel", runId }, 10_000);
  }

  private async steer(
    projectId: string,
    parentThreadId: string,
    runId: string,
    childIndex: number,
    message: string,
  ): Promise<void> {
    const record = this.requireRecord(projectId, parentThreadId, runId, childIndex);
    await record.client.request({ type: "subagentSteer", runId, message }, 10_000);
  }

  private requireRecord(
    projectId: string,
    parentThreadId: string,
    runId: string,
    childIndex: number,
  ): SubagentWorkerRecord {
    const record = this.records.get(workerKey(projectId, parentThreadId, runId, childIndex));
    if (!record) throw new Error(`Subagent run is not active: ${runId}/${childIndex}`);
    return record;
  }

  private handleEvent(record: SubagentWorkerRecord, event: SidecarEvent): void {
    if (!record || this.records.get(record.key) !== record) return;
    if (event.event.type === "session-push") {
      this.options.push?.(event.event.payload, event.workerInstanceId, event.sequence);
      if (!this.options.push) record.client.acknowledge(event.sequence);
      return;
    }
    if (event.event.type === "subagent-event") {
      if (event.event.event.type === "completed" || event.event.event.type === "failed") {
        record.terminalEvent = event.event.event;
      }
      const persistence = this.projectCatalogEvent(record, event.event.event);
      record.emit(event.event.event);
      if (persistence && (event.event.event.type === "completed" || event.event.event.type === "failed")) {
        void persistence.then(
          () => record.client.acknowledge(event.sequence),
          () => record.client.acknowledge(event.sequence),
        );
        return;
      }
    } else if (event.event.type === "resync-required") {
      record.protocolFailure = new Error(`Subagent worker requires resync: ${event.event.reason}`);
      record.failure = record.protocolFailure;
      record.client.fail(record.protocolFailure);
    }
    record.client.acknowledge(event.sequence);
  }

  private recordForThread(projectId: string, threadId: string): SubagentWorkerRecord | undefined {
    return [...this.records.values()].find(
      (record) => record.request.projectId === projectId && record.catalogThread?.id === threadId,
    );
  }

  private projectCatalogEvent(record: SubagentWorkerRecord, event: SubagentRunEvent): Promise<void> | undefined {
    const userPrompt =
      event.type === "message_end" &&
      typeof event.message === "object" &&
      event.message !== null &&
      !Array.isArray(event.message) &&
      event.message.role === "user";
    const initialPrompt = userPrompt && !record.initialPromptObserved;
    if (userPrompt) record.initialPromptObserved = true;
    const announcedSessionFile =
      (event.type === "started" || event.type === "completed" || event.type === "failed") && event.sessionFile
        ? event.sessionFile
        : undefined;
    const sessionFileAnnounced = announcedSessionFile !== undefined && announcedSessionFile !== record.liveSessionFile;
    if (announcedSessionFile) record.liveSessionFile = announcedSessionFile;
    const sessionFile = record.liveSessionFile ?? record.request.sessionFile;
    const firstProjection = !record.catalogThread;
    const current =
      record.catalogThread ??
      (event.type === "started" && event.threadId
        ? threadFromSubagentStart(record.request, event.threadId, event.updatedAt)
        : sessionFile
          ? threadFromSubagentRequest(record.request, sessionFile)
          : undefined);
    if (!current) return undefined;
    if (event.type === "message_update" || event.type === "tool_execution_update") return undefined;
    const terminal = event.type === "completed" || event.type === "failed";
    const promptSubmitted = (event.type === "started" && firstProjection) || (userPrompt && !initialPrompt);
    const next = {
      ...current,
      updatedAt:
        promptSubmitted || terminal ? Math.max(current.updatedAt, event.updatedAt ?? Date.now()) : current.updatedAt,
      messageCount: current.messageCount + (event.type === "message_end" ? 1 : 0),
      running: !terminal,
    };
    record.catalogThread = next;
    const persistence =
      sessionFile && (firstProjection || sessionFileAnnounced || promptSubmitted || terminal)
        ? this.queueMetadataPersistence(record, sessionFile, next)
        : undefined;
    this.options.catalogChanged?.({ ...next });
    return persistence;
  }

  private publishStoppedCatalogThread(record: SubagentWorkerRecord): void {
    if (!record.catalogThread?.running) return;
    record.catalogThread = { ...record.catalogThread, updatedAt: Date.now(), running: false };
    const sessionFile = record.liveSessionFile ?? record.request.sessionFile;
    if (sessionFile) this.queueMetadataPersistence(record, sessionFile, record.catalogThread);
    this.options.catalogChanged?.({ ...record.catalogThread });
  }

  private queueMetadataPersistence(record: SubagentWorkerRecord, sessionFile: string, thread: Thread): Promise<void> {
    const persistSession = this.options.persistSession;
    if (!persistSession) return record.metadataTail;
    const persistence = record.metadataTail
      .catch(() => undefined)
      .then(async () => {
        try {
          await persistSession(record.request.projectId, sessionFile, { ...thread });
          record.metadataFailure = undefined;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          record.metadataFailure = failure;
          this.options.log?.(
            `subagent:${record.request.runId}:${record.request.childIndex}`,
            `Failed to persist subagent session metadata: ${failure.message}`,
          );
          throw failure;
        }
      });
    record.metadataTail = persistence;
    // Active-session persistence has no acknowledgement waiter, so mark the
    // rejection handled immediately while preserving it for barriers below.
    void persistence.catch(() => undefined);
    return persistence;
  }

  private finalizeRecord(record: SubagentWorkerRecord, reason?: string, shutdownTimeout?: number): Promise<void> {
    record.finalizePromise ??= (async () => {
      this.publishStoppedCatalogThread(record);
      await record.client.shutdown(shutdownTimeout).catch(() => undefined);
      await record.metadataTail;
      if (this.records.get(record.key) === record) this.records.delete(record.key);
      if (reason && record.catalogThread) {
        this.options.resync?.(record.request.projectId, record.catalogThread.id, reason);
      }
    })();
    return record.finalizePromise;
  }

  private assertCapacity(projectId: string, parentThreadId: string): void {
    const maximum = this.options.maxWorkers ?? 16;
    if (this.records.size >= maximum) throw new Error(`Desktop subagent worker limit reached (${maximum})`);
    const perThread = [...this.records.values()].filter(
      ({ request }) => request.projectId === projectId && request.parentThreadId === parentThreadId,
    ).length;
    const threadMaximum = this.options.maxWorkersPerThread ?? 8;
    if (perThread >= threadMaximum) {
      throw new Error(`Desktop subagent worker limit reached for this thread (${threadMaximum})`);
    }
  }
}

function threadFromSubagentStart(request: SubagentRunRequest, threadId: string, updatedAt = Date.now()): Thread {
  return createSubagentThread(
    request,
    threadId,
    updatedAt,
    request.parentSessionId ?? request.parentThreadId,
    updatedAt,
  );
}

function threadFromSubagentRequest(request: SubagentRunRequest, sessionFile: string): Thread | undefined {
  const header = readSessionHeader(sessionFile);
  if (!header) return undefined;
  const parentThreadId = header.parentSessionPath
    ? (readSessionHeader(header.parentSessionPath)?.id ?? request.parentSessionId ?? request.parentThreadId)
    : (request.parentSessionId ?? request.parentThreadId);
  return createSubagentThread(request, header.id, header.createdAt, parentThreadId);
}

function createSubagentThread(
  request: SubagentRunRequest,
  threadId: string,
  createdAt: number,
  parentThreadId: string,
  updatedAt = Date.now(),
): Thread {
  const title = subagentTitle(request.task);
  return {
    id: threadId,
    projectId: request.projectId,
    title,
    createdAt,
    updatedAt,
    messageCount: 0,
    preview: title,
    archived: false,
    running: true,
    parentThreadId,
    origin: "subagent",
    agentName: request.agent,
  };
}

function readSessionHeader(
  sessionFile: string,
): { id: string; createdAt: number; parentSessionPath?: string } | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(8 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return undefined;
    const value: unknown = JSON.parse(firstLine);
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "session" ||
      !("id" in value) ||
      typeof value.id !== "string"
    ) {
      return undefined;
    }
    const timestamp = "timestamp" in value && typeof value.timestamp === "string" ? Date.parse(value.timestamp) : NaN;
    const parentSessionPath =
      "parentSession" in value && typeof value.parentSession === "string" ? value.parentSession : undefined;
    return {
      id: value.id,
      createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      ...(parentSessionPath ? { parentSessionPath } : {}),
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function subagentTitle(task: string): string {
  const delegatedTask = /(?:^|\n)Task:\n([\s\S]*?)(?:\n\n##|$)/.exec(task)?.[1] ?? task;
  const firstLine = delegatedTask
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("[Read from:"));
  return (firstLine ?? "子智能体会话").replace(/\s+/g, " ").slice(0, 48);
}

function validateRunRequest(request: SubagentRunRequest): void {
  if (!request.runId.trim()) throw new Error("Subagent run ID is required");
  if (!Number.isSafeInteger(request.childIndex) || request.childIndex < 0) {
    throw new Error("Subagent child index must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(request.depth) ||
    !Number.isSafeInteger(request.maxDepth) ||
    request.depth < 1 ||
    request.maxDepth < request.depth ||
    request.lineage.some(
      ({ runId, childIndex }) => !runId.trim() || !Number.isSafeInteger(childIndex) || childIndex < 0,
    )
  ) {
    throw new Error("Subagent depth and lineage must be valid");
  }
  if (!isAbsolute(request.cwd)) throw new Error("Subagent cwd must be absolute");
  if (request.sessionFile && !isAbsolute(request.sessionFile)) {
    throw new Error("Subagent session file must be absolute");
  }
  if (request.sessionDir && !isAbsolute(request.sessionDir)) {
    throw new Error("Subagent session directory must be absolute");
  }
  const profiles = new Set(["provider", "memory", "runtime", "fanout"]);
  if (request.extensionProfile.some((profile) => !profiles.has(profile))) {
    throw new Error("Subagent extension profile contains an unsupported capability");
  }
  if (request.tools?.some((tool) => tool.includes("/") || tool.includes("\\") || /\.[cm]?[jt]s$/i.test(tool))) {
    throw new Error("Subagent tools must be registered tool names, not extension paths");
  }
  const childExtensionPaths = new Set<string>();
  for (const extension of request.childExtensions ?? []) {
    if (!isAbsolute(extension.path)) throw new Error("Child extension paths must be absolute");
    if (childExtensionPaths.has(extension.path)) throw new Error("Child extension paths must be unique");
    childExtensionPaths.add(extension.path);
    if (
      !extension.tools.length ||
      extension.tools.some((tool) => tool.includes("/") || tool.includes("\\") || /\.[cm]?[jt]s$/i.test(tool))
    ) {
      throw new Error("Child extension tools must be registered tool names");
    }
  }
}

function validateRootRequest(request: SubagentRunRequest): void {
  if (request.depth !== 1 || request.rootRunId !== request.runId || request.lineage.length !== 0) {
    throw new Error("Root subagent request has invalid lineage");
  }
}

function validateNestedRequest(parent: SubagentRunRequest, request: SubagentRunRequest): void {
  if (request.projectId !== parent.projectId || request.parentThreadId !== parent.parentThreadId) {
    throw new Error("Nested subagent request escaped its parent thread");
  }
  if (parent.depth >= parent.maxDepth || request.depth !== parent.depth + 1) {
    throw new Error(`Nested subagent depth is invalid (${request.depth}/${parent.maxDepth})`);
  }
  if (request.maxDepth > parent.maxDepth || request.rootRunId !== parent.rootRunId) {
    throw new Error("Nested subagent request changed its root limits");
  }
  const expectedLineage = [...parent.lineage, { runId: parent.runId, childIndex: parent.childIndex }];
  if (!sameLineage(request.lineage, expectedLineage)) {
    throw new Error("Nested subagent request lineage does not match its parent worker");
  }
  if (!sameChildExtensions(parent.childExtensions, request.childExtensions)) {
    throw new Error("Nested subagent request changed its approved child extensions");
  }
}

function validateDirectChild(parent: SubagentRunRequest, child: SubagentRunRequest): void {
  if (
    child.projectId !== parent.projectId ||
    child.parentThreadId !== parent.parentThreadId ||
    child.rootRunId !== parent.rootRunId ||
    !sameLineage(child.lineage, [...parent.lineage, { runId: parent.runId, childIndex: parent.childIndex }])
  ) {
    throw new Error("Nested subagent control target is not a direct child of this worker");
  }
}

function isDescendant(parent: SubagentRunRequest, candidate: SubagentRunRequest): boolean {
  if (
    candidate.projectId !== parent.projectId ||
    candidate.parentThreadId !== parent.parentThreadId ||
    candidate.rootRunId !== parent.rootRunId
  ) {
    return false;
  }
  return candidate.lineage.some(
    (ancestor) => ancestor.runId === parent.runId && ancestor.childIndex === parent.childIndex,
  );
}

function sameChildExtensions(
  actual: SubagentRunRequest["childExtensions"],
  expected: SubagentRunRequest["childExtensions"],
): boolean {
  const signature = (extensions: SubagentRunRequest["childExtensions"]): string[] =>
    (extensions ?? []).map((extension) => `${extension.path}\0${[...extension.tools].sort().join("\0")}`).sort();
  const actualSignature = signature(actual);
  const expectedSignature = signature(expected);
  return (
    actualSignature.length === expectedSignature.length &&
    actualSignature.every((item, index) => item === expectedSignature[index])
  );
}

function sameLineage(actual: SubagentRunRequest["lineage"], expected: SubagentRunRequest["lineage"]): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (ancestor, index) =>
        ancestor.runId === expected[index]?.runId && ancestor.childIndex === expected[index]?.childIndex,
    )
  );
}

function recordUsesParentSession(record: SubagentWorkerRecord, parentSessionId: string): boolean {
  return (
    record.request.parentThreadId === parentSessionId ||
    record.request.parentSessionId === parentSessionId ||
    record.catalogThread?.parentThreadId === parentSessionId
  );
}

function parentThreadKey(projectId: string, parentThreadId: string): string {
  return `${projectId}\0${parentThreadId}`;
}

function workerKey(projectId: string, parentThreadId: string, runId: string, childIndex: number): string {
  return `${projectId}\0${parentThreadId}\0${runId}\0${childIndex}`;
}
