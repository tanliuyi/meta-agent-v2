import { isAbsolute } from "node:path";
import type { JsonValue } from "../../shared/contracts.ts";
import type { SidecarEvent } from "../../shared/sidecar-contracts.ts";
import type {
  SubagentHostRequest,
  SubagentRunEvent,
  SubagentRunRequest,
  SubagentWorkerBinding,
} from "../../shared/subagent-contracts.ts";
import type { NodeRuntimeManifest } from "./node-runtime-locator.ts";
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
  request: SubagentRunRequest;
  client: SubagentWorkerClient;
  emit(event: SubagentRunEvent): void;
  failure?: Error;
}

export interface SubagentWorkerRegistryOptions {
  manifest: NodeRuntimeManifest;
  agentDir: string;
  log?(scope: string, text: string): void;
  createWorkerClient?(options: WorkerClientOptions): SubagentWorkerClient;
  maxWorkers?: number;
  maxWorkersPerThread?: number;
}

/** Main-owned lifecycle registry for programmatic subagent sidecars. */
export class SubagentWorkerRegistry {
  private readonly options: SubagentWorkerRegistryOptions;
  private readonly records = new Map<string, SubagentWorkerRecord>();
  private disposing = false;

  constructor(options: SubagentWorkerRegistryOptions) {
    this.options = options;
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

  async cancelThread(projectId: string, parentThreadId: string): Promise<void> {
    const records = [...this.records.values()].filter(
      ({ request }) => request.projectId === projectId && request.parentThreadId === parentThreadId,
    );
    for (const record of records) {
      if (this.records.get(record.key) === record) this.records.delete(record.key);
    }
    await Promise.allSettled(records.map(({ client }) => client.shutdown(5_000)));
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const records = [...this.records.values()];
    this.records.clear();
    await Promise.allSettled(records.map(({ client }) => client.shutdown()));
  }

  private async run(
    request: SubagentRunRequest,
    emit: (event: SubagentRunEvent) => void,
    parent?: SubagentWorkerRecord,
  ): Promise<JsonValue> {
    if (this.disposing) throw new Error("Desktop subagent worker registry is shutting down");
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
    record = { key, request, client, emit };
    this.records.set(key, record);
    try {
      await client.ready();
      const result = await client.request<JsonValue>({ type: "subagentRun", request }, null);
      if (record.failure) throw record.failure;
      return result;
    } finally {
      await this.cancelDescendants(record);
      if (this.records.get(key) === record) this.records.delete(key);
      await client.shutdown().catch(() => undefined);
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
    for (const descendant of descendants) {
      if (this.records.get(descendant.key) === descendant) this.records.delete(descendant.key);
    }
    await Promise.allSettled(descendants.map(({ client }) => client.shutdown(5_000)));
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
    if (event.event.type === "subagent-event") record.emit(event.event.event);
    else if (event.event.type === "resync-required") {
      record.failure = new Error(`Subagent worker requires resync: ${event.event.reason}`);
      record.client.fail(record.failure);
    }
    record.client.acknowledge(event.sequence);
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

function sameLineage(actual: SubagentRunRequest["lineage"], expected: SubagentRunRequest["lineage"]): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (ancestor, index) =>
        ancestor.runId === expected[index]?.runId && ancestor.childIndex === expected[index]?.childIndex,
    )
  );
}

function workerKey(projectId: string, parentThreadId: string, runId: string, childIndex: number): string {
  return `${projectId}\0${parentThreadId}\0${runId}\0${childIndex}`;
}
