import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedExtensionSet } from "../../shared/desktop-extension-contracts.ts";
import type { MarketplaceGenerationReferenceTracker } from "./marketplace-generation-reference-tracker.ts";

export type MarketplaceExtensionApplyPhase = "apply-pending" | "apply-validated" | "rollback-pending";

export interface MarketplaceExtensionApplyRecord {
  schemaVersion: 1;
  operationId: string;
  projectId: string;
  threadId: string;
  phase: MarketplaceExtensionApplyPhase;
  beforeSet: ResolvedExtensionSet;
  afterGeneration: string;
  previousWorkerInstanceId: string;
  previousWorkerPid?: number;
  replacementWorkerInstanceId?: string;
  replacementWorkerPid?: number;
  mutationOperationId?: string;
  createdAt: number;
  updatedAt: number;
}

interface MarketplaceExtensionApplyJournalOptions {
  createId?(): string;
  now?(): number;
  waitForProcessExitMs?: number;
  mutationLifecycle?: {
    rollback(operationId: string): Promise<void>;
    complete(operationId: string): Promise<void>;
  };
}

export class MarketplaceExtensionApplyJournal {
  readonly directory: string;
  private readonly references: Pick<MarketplaceGenerationReferenceTracker, "retain" | "release">;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly waitForProcessExitMs: number;
  private readonly mutationLifecycle?: MarketplaceExtensionApplyJournalOptions["mutationLifecycle"];
  private readonly rollbackOverrides = new Map<string, MarketplaceExtensionApplyRecord>();

  constructor(
    userDataDir: string,
    references: Pick<MarketplaceGenerationReferenceTracker, "retain" | "release">,
    options: MarketplaceExtensionApplyJournalOptions = {},
  ) {
    this.directory = join(userDataDir, "plugins", "apply-transactions");
    this.references = references;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.waitForProcessExitMs = options.waitForProcessExitMs ?? 10_000;
    this.mutationLifecycle = options.mutationLifecycle;
  }

  async prepare(input: {
    projectId: string;
    threadId: string;
    beforeSet: ResolvedExtensionSet;
    afterGeneration: string;
    previousWorkerInstanceId: string;
    previousWorkerPid?: number;
    mutationOperationId?: string;
  }): Promise<MarketplaceExtensionApplyRecord> {
    if (this.rollbackOverrides.has(workerKey(input.projectId, input.threadId))) {
      throw new Error("A marketplace extension apply recovery is already pending for this thread");
    }
    const now = this.now();
    const record: MarketplaceExtensionApplyRecord = {
      schemaVersion: 1,
      operationId: this.createId(),
      projectId: input.projectId,
      threadId: input.threadId,
      phase: "apply-pending",
      beforeSet: cloneSet(input.beforeSet),
      afterGeneration: input.afterGeneration,
      previousWorkerInstanceId: input.previousWorkerInstanceId,
      ...(input.previousWorkerPid === undefined ? {} : { previousWorkerPid: input.previousWorkerPid }),
      ...(input.mutationOperationId === undefined ? {} : { mutationOperationId: input.mutationOperationId }),
      createdAt: now,
      updatedAt: now,
    };
    assertRecord(record);
    await this.write(record, true);
    this.references.retain(referenceOwner(record.operationId), record.beforeSet);
    return cloneRecord(record);
  }

  async replacementStarted(
    record: MarketplaceExtensionApplyRecord,
    workerInstanceId: string,
    workerPid?: number,
  ): Promise<MarketplaceExtensionApplyRecord> {
    const updated: MarketplaceExtensionApplyRecord = {
      ...cloneRecord(record),
      replacementWorkerInstanceId: workerInstanceId,
      ...(workerPid === undefined ? {} : { replacementWorkerPid: workerPid }),
      updatedAt: this.now(),
    };
    if (workerPid === undefined) delete updated.replacementWorkerPid;
    await this.write(updated, false);
    return updated;
  }

  async startupRollbackStarted(operationId: string, workerInstanceId: string, workerPid?: number): Promise<void> {
    const record = [...this.rollbackOverrides.values()].find((entry) => entry.operationId === operationId);
    if (!record) throw new Error(`Marketplace apply rollback is unavailable: ${operationId}`);
    const updated = await this.replacementStarted(record, workerInstanceId, workerPid);
    this.rollbackOverrides.set(workerKey(updated.projectId, updated.threadId), cloneRecord(updated));
  }

  async validated(record: MarketplaceExtensionApplyRecord): Promise<void> {
    const updated = await this.setPhase(record, "apply-validated");
    if (updated.mutationOperationId) await this.mutationLifecycle?.complete(updated.mutationOperationId);
    await this.complete(updated);
  }

  async beginRollback(record: MarketplaceExtensionApplyRecord): Promise<MarketplaceExtensionApplyRecord> {
    const updated =
      record.phase === "rollback-pending" ? cloneRecord(record) : await this.setPhase(record, "rollback-pending");
    if (updated.mutationOperationId) await this.mutationLifecycle?.rollback(updated.mutationOperationId);
    return updated;
  }

  async rollbackValidated(record: MarketplaceExtensionApplyRecord): Promise<void> {
    const updated = await this.beginRollback(record);
    if (updated.mutationOperationId) await this.mutationLifecycle?.complete(updated.mutationOperationId);
    await this.complete(updated);
  }

  async reconcileStartup(): Promise<void> {
    this.rollbackOverrides.clear();
    for (let record of await this.list()) {
      this.references.retain(referenceOwner(record.operationId), record.beforeSet);
      if (record.previousWorkerPid !== undefined) {
        await waitForProcessExit(record.previousWorkerPid, this.waitForProcessExitMs);
      }
      if (record.replacementWorkerPid !== undefined) {
        await waitForProcessExit(record.replacementWorkerPid, this.waitForProcessExitMs);
      }
      if (record.phase === "apply-validated") {
        if (record.mutationOperationId) await this.mutationLifecycle?.complete(record.mutationOperationId);
        await this.complete(record);
        continue;
      }
      if (record.phase === "apply-pending") {
        record = await this.beginRollback(record);
      } else if (record.phase === "rollback-pending" && record.mutationOperationId) {
        await this.mutationLifecycle?.rollback(record.mutationOperationId);
      }
      const key = workerKey(record.projectId, record.threadId);
      if (this.rollbackOverrides.has(key)) {
        throw new Error(`Multiple marketplace apply recoveries target ${record.projectId}/${record.threadId}`);
      }
      this.rollbackOverrides.set(key, cloneRecord(record));
    }
  }

  getRollbackOverride(
    projectId: string,
    threadId: string,
  ): { operationId: string; extensionSet: ResolvedExtensionSet } | undefined {
    const record = this.rollbackOverrides.get(workerKey(projectId, threadId));
    if (!record) return undefined;
    return { operationId: record.operationId, extensionSet: cloneSet(record.beforeSet) };
  }

  async completeStartupRollback(operationId: string): Promise<void> {
    const record = [...this.rollbackOverrides.values()].find((entry) => entry.operationId === operationId);
    if (!record) throw new Error(`Marketplace apply rollback is unavailable: ${operationId}`);
    this.rollbackOverrides.delete(workerKey(record.projectId, record.threadId));
    if (record.mutationOperationId) await this.mutationLifecycle?.complete(record.mutationOperationId);
    await this.complete(record);
  }

  async hasMutationOperation(operationId: string): Promise<boolean> {
    return (await this.list()).some((record) => record.mutationOperationId === operationId);
  }

  async list(): Promise<MarketplaceExtensionApplyRecord[]> {
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Marketplace apply journal directory is unsafe");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const records: MarketplaceExtensionApplyRecord[] = [];
    for (const entry of (await readdir(this.directory)).sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.directory, entry);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Marketplace apply journal is unsafe: ${entry}`);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error(`Marketplace apply journal JSON is invalid: ${entry}`);
      }
      assertRecord(value);
      if (`${value.operationId}.json` !== entry)
        throw new Error(`Marketplace apply journal identity is invalid: ${entry}`);
      records.push(cloneRecord(value));
    }
    return records;
  }

  private async setPhase(
    record: MarketplaceExtensionApplyRecord,
    phase: MarketplaceExtensionApplyPhase,
  ): Promise<MarketplaceExtensionApplyRecord> {
    const updated = { ...cloneRecord(record), phase, updatedAt: this.now() };
    await this.write(updated, false);
    return updated;
  }

  private async complete(record: MarketplaceExtensionApplyRecord): Promise<void> {
    await rm(this.pathFor(record.operationId), { force: true });
    await syncDirectory(this.directory);
    this.references.release(referenceOwner(record.operationId));
  }

  private async write(record: MarketplaceExtensionApplyRecord, createOnly: boolean): Promise<void> {
    assertRecord(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(record.operationId);
    if (createOnly) {
      try {
        await lstat(path);
        throw new Error(`Marketplace apply journal already exists: ${record.operationId}`);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
    const temp = join(this.directory, `.${record.operationId}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, path);
      await chmod(path, 0o600);
      await syncDirectory(this.directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private pathFor(operationId: string): string {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(operationId)) throw new Error("Marketplace apply operation ID is invalid");
    return join(this.directory, `${operationId}.json`);
  }
}

function assertRecord(value: unknown): asserts value is MarketplaceExtensionApplyRecord {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.threadId !== "string" ||
    (value.phase !== "apply-pending" && value.phase !== "apply-validated" && value.phase !== "rollback-pending") ||
    !isResolvedExtensionSet(value.beforeSet) ||
    typeof value.afterGeneration !== "string" ||
    typeof value.previousWorkerInstanceId !== "string" ||
    (value.previousWorkerPid !== undefined &&
      (typeof value.previousWorkerPid !== "number" ||
        !Number.isSafeInteger(value.previousWorkerPid) ||
        value.previousWorkerPid <= 0)) ||
    (value.replacementWorkerInstanceId !== undefined && typeof value.replacementWorkerInstanceId !== "string") ||
    (value.replacementWorkerPid !== undefined &&
      (typeof value.replacementWorkerPid !== "number" ||
        !Number.isSafeInteger(value.replacementWorkerPid) ||
        value.replacementWorkerPid <= 0)) ||
    (value.mutationOperationId !== undefined && typeof value.mutationOperationId !== "string") ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    throw new Error("Marketplace apply journal record is invalid");
  }
}

function isResolvedExtensionSet(value: unknown): value is ResolvedExtensionSet {
  return (
    isObject(value) &&
    typeof value.generation === "string" &&
    typeof value.projectId === "string" &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.id === "string" &&
        typeof entry.displayName === "string" &&
        typeof entry.source === "string" &&
        (entry.entryPath === undefined || typeof entry.entryPath === "string") &&
        entry.configuration === undefined &&
        Array.isArray(entry.capabilities),
    ) &&
    Array.isArray(value.diagnostics) &&
    typeof value.resolvedAt === "number"
  );
}

function cloneRecord(record: MarketplaceExtensionApplyRecord): MarketplaceExtensionApplyRecord {
  return { ...record, beforeSet: cloneSet(record.beforeSet) };
}

function cloneSet(set: ResolvedExtensionSet): ResolvedExtensionSet {
  return {
    ...set,
    entries: set.entries.map(({ configuration: _configuration, ...entry }) => ({
      ...entry,
      capabilities: [...entry.capabilities],
    })),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function referenceOwner(operationId: string): string {
  return `apply:${operationId}`;
}

function workerKey(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`;
}

const execFileAsync = promisify(execFile);

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) {
      // PID 可能被无关进程复用；只有当存活进程看起来确实是 sidecar writer 时才阻断启动恢复。
      if (!(await isLikelySidecarProcess(pid))) return;
      throw new Error(`Previous Desktop sidecar writer is still alive: ${pid}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function isLikelySidecarProcess(pid: number): Promise<boolean> {
  // 无法读取命令行时 fail closed，保持单写入者保护。
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
    const command = stdout.trim();
    if (!command) return false;
    return /node|electron/i.test(command);
  } catch {
    // ps 对不存在的 PID 退出非零：进程已退出或属于其他用户（PID 已复用）。
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
