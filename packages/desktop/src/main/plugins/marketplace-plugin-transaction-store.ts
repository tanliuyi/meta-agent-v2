import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { InstalledMarketplacePluginRecord } from "./marketplace-plugin-registry.ts";

export type MarketplacePluginTransactionPhase =
  | "prepared"
  | "files-ready"
  | "registry-committed"
  | "projection-committed"
  | "rollback-pending";

export interface MarketplacePluginTransaction {
  schemaVersion: 1;
  operationId: string;
  requestId: string;
  operation: "install" | "update" | "uninstall";
  pluginId: string;
  phase: MarketplacePluginTransactionPhase;
  before?: InstalledMarketplacePluginRecord;
  after?: InstalledMarketplacePluginRecord;
  rootPath: string;
  versionPath?: string;
  stagingPath?: string;
  removeVersionOnRollback?: boolean;
  removeRootOnRollback?: boolean;
  preserveFiles?: boolean;
  applyTarget?: { projectId: string; threadId: string };
  createdAt: number;
  updatedAt: number;
}

interface MarketplacePluginTransactionStoreOptions {
  createId?(): string;
  now?(): number;
}

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

export class MarketplacePluginTransactionStore {
  readonly directory: string;
  private readonly lockDirectory: string;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(userDataDir: string, options: MarketplacePluginTransactionStoreOptions = {}) {
    this.directory = join(userDataDir, "plugins", "transactions");
    this.lockDirectory = join(userDataDir, "plugins", "locks");
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async prepare(
    input: Omit<MarketplacePluginTransaction, "schemaVersion" | "operationId" | "phase" | "createdAt" | "updatedAt">,
  ): Promise<MarketplacePluginTransaction> {
    const now = this.now();
    const transaction: MarketplacePluginTransaction = {
      ...input,
      schemaVersion: 1,
      operationId: this.createId(),
      phase: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    assertTransaction(transaction);
    await this.write(transaction, true);
    return cloneTransaction(transaction);
  }

  async setPhase(
    transaction: MarketplacePluginTransaction,
    phase: MarketplacePluginTransactionPhase,
  ): Promise<MarketplacePluginTransaction> {
    const updated = { ...cloneTransaction(transaction), phase, updatedAt: this.now() };
    assertTransaction(updated);
    await this.write(updated, false);
    return cloneTransaction(updated);
  }

  async complete(transaction: MarketplacePluginTransaction): Promise<void> {
    const path = this.pathFor(transaction.operationId);
    await rm(path, { force: true });
    await syncDirectory(this.directory);
  }

  async list(): Promise<MarketplacePluginTransaction[]> {
    try {
      const info = await lstat(this.directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Marketplace transaction directory is unsafe");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const transactions: MarketplacePluginTransaction[] = [];
    for (const entry of (await readdir(this.directory)).sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(this.directory, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Marketplace transaction is unsafe: ${entry}`);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new Error(`Marketplace transaction JSON is invalid: ${entry}`);
      }
      assertTransaction(value);
      if (`${value.operationId}.json` !== entry)
        throw new Error(`Marketplace transaction identity is invalid: ${entry}`);
      transactions.push(cloneTransaction(value));
    }
    return transactions;
  }

  async withPluginLock<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    if (!SAFE_ID.test(pluginId)) throw new Error("Marketplace plugin lock ID is invalid");
    await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 });
    const target = join(this.lockDirectory, pluginId);
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 5_000,
      update: 1_000,
      retries: { retries: 12, factor: 1.4, minTimeout: 100, maxTimeout: 1_000, randomize: true },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private pathFor(operationId: string): string {
    if (!SAFE_ID.test(operationId)) throw new Error("Marketplace transaction operation ID is invalid");
    return join(this.directory, `${operationId}.json`);
  }

  private async write(transaction: MarketplacePluginTransaction, createOnly: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(transaction.operationId);
    if (createOnly) {
      try {
        await lstat(path);
        throw new Error(`Marketplace transaction already exists: ${transaction.operationId}`);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
    const temp = join(this.directory, `.${transaction.operationId}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(transaction, null, 2)}\n`, "utf8");
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
}

function assertTransaction(value: unknown): asserts value is MarketplacePluginTransaction {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.requestId !== "string" ||
    !SAFE_ID.test(value.requestId) ||
    (value.operation !== "install" && value.operation !== "update" && value.operation !== "uninstall") ||
    typeof value.pluginId !== "string" ||
    !SAFE_ID.test(value.pluginId) ||
    !isPhase(value.phase) ||
    typeof value.rootPath !== "string" ||
    (value.versionPath !== undefined && typeof value.versionPath !== "string") ||
    (value.stagingPath !== undefined && typeof value.stagingPath !== "string") ||
    (value.removeVersionOnRollback !== undefined && typeof value.removeVersionOnRollback !== "boolean") ||
    (value.removeRootOnRollback !== undefined && typeof value.removeRootOnRollback !== "boolean") ||
    (value.preserveFiles !== undefined && typeof value.preserveFiles !== "boolean") ||
    (value.applyTarget !== undefined &&
      (!isObject(value.applyTarget) ||
        typeof value.applyTarget.projectId !== "string" ||
        typeof value.applyTarget.threadId !== "string")) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    (value.before !== undefined && !isInstalledRecord(value.before)) ||
    (value.after !== undefined && !isInstalledRecord(value.after)) ||
    (value.operation === "install" && value.after === undefined) ||
    (value.operation === "update" && (value.before === undefined || value.after === undefined)) ||
    (value.operation === "uninstall" && value.before === undefined)
  ) {
    throw new Error("Marketplace transaction record is invalid");
  }
}

function isInstalledRecord(value: unknown): value is InstalledMarketplacePluginRecord {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.marketplaceId === "string" &&
    typeof value.version === "string" &&
    typeof value.artifactId === "string" &&
    typeof value.artifactHash === "string" &&
    typeof value.entryPath === "string" &&
    typeof value.rootPath === "string" &&
    typeof value.displayName === "string" &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((item) => typeof item === "string") &&
    typeof value.containsNativeCode === "boolean" &&
    (value.state === "installed" || value.state === "broken") &&
    typeof value.installedAt === "number" &&
    Array.isArray(value.verifiedFiles) &&
    value.verifiedFiles.every(
      (file) =>
        isObject(file) &&
        typeof file.path === "string" &&
        typeof file.sha256 === "string" &&
        typeof file.size === "number",
    )
  );
}

function cloneTransaction(transaction: MarketplacePluginTransaction): MarketplacePluginTransaction {
  return {
    ...transaction,
    ...(transaction.before ? { before: cloneRecord(transaction.before) } : {}),
    ...(transaction.after ? { after: cloneRecord(transaction.after) } : {}),
  };
}

function cloneRecord(record: InstalledMarketplacePluginRecord): InstalledMarketplacePluginRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    verifiedFiles: record.verifiedFiles.map((file) => ({ ...file })),
  };
}

function isPhase(value: unknown): value is MarketplacePluginTransactionPhase {
  return (
    value === "prepared" ||
    value === "files-ready" ||
    value === "registry-committed" ||
    value === "projection-committed" ||
    value === "rollback-pending"
  );
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
