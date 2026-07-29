import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMarketplaceVersionOwner,
  writeMarketplaceProjection,
} from "../src/main/plugins/marketplace-installed-plugin.ts";
import { MarketplacePluginReconciler } from "../src/main/plugins/marketplace-plugin-reconciler.ts";
import {
  type InstalledMarketplacePluginRecord,
  MarketplacePluginRegistry,
  MISSING_MARKETPLACE_REGISTRY_REVISION,
} from "../src/main/plugins/marketplace-plugin-registry.ts";
import { MarketplacePluginTransactionStore } from "../src/main/plugins/marketplace-plugin-transaction-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarketplacePluginReconciler", () => {
  it("fails closed on a malformed durable transaction", async () => {
    const harness = await createHarness();
    await mkdir(harness.transactions.directory, { recursive: true });
    await writeFile(join(harness.transactions.directory, "invalid.json"), "{}\n", "utf8");

    await expect(harness.reconciler.reconcile()).rejects.toThrow("transaction record is invalid");
  });

  it("removes an uncommitted immutable version from a files-ready install", async () => {
    const harness = await createHarness();
    let transaction = await harness.transactions.prepare({
      requestId: "install-files-ready",
      operation: "install",
      pluginId: harness.record.id,
      after: harness.record,
      rootPath: harness.record.rootPath,
      versionPath: harness.versionRoot,
      stagingPath: join(
        harness.agentDir,
        "extensions",
        ".meta-agent-marketplace-staging",
        `${harness.record.id}-install`,
      ),
      removeVersionOnRollback: true,
      removeRootOnRollback: true,
    });
    transaction = await harness.transactions.setPhase(transaction, "files-ready");

    await harness.reconciler.reconcile();
    await harness.reconciler.reconcile();

    await expect(pathExists(harness.versionRoot)).resolves.toBe(false);
    await expect(harness.registry.getSnapshot()).resolves.toEqual({
      revision: MISSING_MARKETPLACE_REGISTRY_REVISION,
      plugins: [],
    });
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("cleans a rollback-pending uncommitted new install without leaving ownership metadata", async () => {
    const harness = await createHarness();
    let transaction = await harness.transactions.prepare({
      requestId: "install-rollback-uncommitted",
      operation: "install",
      pluginId: harness.record.id,
      after: harness.record,
      rootPath: harness.record.rootPath,
      versionPath: harness.versionRoot,
      removeVersionOnRollback: true,
      removeRootOnRollback: true,
    });
    transaction = await harness.transactions.setPhase(transaction, "rollback-pending");

    await harness.reconciler.reconcile();
    await harness.reconciler.reconcile();

    await expect(pathExists(harness.versionRoot)).resolves.toBe(false);
    await expect(pathExists(harness.record.rootPath)).resolves.toBe(false);
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("finishes install rollback after registry removal but before inactivity and tombstone writes", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    let transaction = await harness.transactions.prepare({
      requestId: "install-rollback-crash",
      operation: "install",
      pluginId: harness.record.id,
      after: harness.record,
      rootPath: harness.record.rootPath,
      versionPath: harness.versionRoot,
      removeVersionOnRollback: false,
      removeRootOnRollback: false,
    });
    transaction = await harness.transactions.setPhase(transaction, "rollback-pending");
    await harness.registry.reconcilePlugin(harness.record.id, harness.record.artifactHash, undefined);

    await harness.reconciler.reconcile();
    await harness.reconciler.reconcile();

    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(false);
    expect(JSON.parse(await readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8"))).toMatchObject({
      version: 1,
      state: "uninstalled",
      operationId: transaction.operationId,
      pluginId: harness.record.id,
      artifactHash: harness.record.artifactHash,
      uninstalledAt: 200,
    });
    await expect(readMarketplaceVersionOwner(harness.record.rootPath, harness.record.artifactHash)).resolves.toEqual({
      record: harness.record,
      inactiveAt: 200,
    });
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("removes known pre-journal staging orphans without deleting unknown entries", async () => {
    const harness = await createHarness();
    const stagingRoot = join(harness.agentDir, "extensions", ".meta-agent-marketplace-staging");
    const orphan = join(stagingRoot, `${harness.record.id}-orphan`);
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "partial"), "partial", "utf8");
    await writeFile(join(stagingRoot, "README"), "unknown", "utf8");

    await harness.reconciler.reconcile();

    await expect(pathExists(orphan)).resolves.toBe(false);
    await expect(readFile(join(stagingRoot, "README"), "utf8")).resolves.toBe("unknown");
  });

  it("completes projection after an install registry commit", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    let transaction = await harness.transactions.prepare({
      requestId: "install-registry-committed",
      operation: "install",
      pluginId: harness.record.id,
      after: harness.record,
      rootPath: harness.record.rootPath,
      versionPath: harness.versionRoot,
    });
    transaction = await harness.transactions.setPhase(transaction, "registry-committed");

    await harness.reconciler.reconcile();

    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toContain(
      `./.versions/${harness.record.artifactHash}/payload/index.ts`,
    );
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("removes an uncommitted update version while retaining the active version", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    const after = await createUpdatedRecord(harness);
    let transaction = await harness.transactions.prepare({
      requestId: "update-files-ready",
      operation: "update",
      pluginId: harness.record.id,
      before: harness.record,
      after,
      rootPath: harness.record.rootPath,
      versionPath: join(harness.record.rootPath, ".versions", after.artifactHash),
      removeVersionOnRollback: true,
      removeRootOnRollback: false,
    });
    transaction = await harness.transactions.setPhase(transaction, "files-ready");

    await harness.reconciler.reconcile();

    await expect(pathExists(join(harness.record.rootPath, ".versions", after.artifactHash))).resolves.toBe(false);
    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toContain(
      harness.record.artifactHash,
    );
    await expect(harness.registry.getSnapshot()).resolves.toEqual(installed.snapshot);
  });

  it("completes an update projection after its registry commit", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    const after = await createUpdatedRecord(harness);
    let transaction = await harness.transactions.prepare({
      requestId: "update-registry-committed",
      operation: "update",
      pluginId: harness.record.id,
      before: harness.record,
      after,
      rootPath: harness.record.rootPath,
      versionPath: join(harness.record.rootPath, ".versions", after.artifactHash),
      removeVersionOnRollback: true,
      removeRootOnRollback: false,
    });
    const updated = await harness.registry.commitUpdate(
      installed.snapshot.revision,
      harness.record.artifactHash,
      after,
    );
    if (updated.status !== "saved") throw new Error("Expected registry update");
    transaction = await harness.transactions.setPhase(transaction, "registry-committed");

    await harness.reconciler.reconcile();

    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toContain(after.artifactHash);
    await expect(pathExists(harness.versionRoot)).resolves.toBe(true);
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("finishes an uninstall committed before its projection was removed", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    let transaction = await harness.transactions.prepare({
      requestId: "uninstall-registry-committed",
      operation: "uninstall",
      pluginId: harness.record.id,
      before: harness.record,
      rootPath: harness.record.rootPath,
      versionPath: harness.versionRoot,
    });
    await harness.registry.commitUninstall(installed.snapshot.revision, harness.record.id);
    transaction = await harness.transactions.setPhase(transaction, "registry-committed");

    await harness.reconciler.reconcile();
    await harness.reconciler.reconcile();

    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(false);
    await expect(pathExists(harness.versionRoot)).resolves.toBe(true);
    await expect(readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8")).resolves.toContain(
      '"state": "uninstalled"',
    );
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("keeps a committed plugin active when its entry bytes change", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    let transaction = await harness.transactions.prepare({
      requestId: "install-corrupt-after-commit",
      operation: "install",
      pluginId: harness.record.id,
      after: harness.record,
      rootPath: harness.record.rootPath,
      versionPath: harness.versionRoot,
    });
    transaction = await harness.transactions.setPhase(transaction, "registry-committed");
    await writeFile(harness.record.entryPath, "modified\n", "utf8");

    await harness.reconciler.reconcile();

    const snapshot = await harness.registry.getInternalSnapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        plugins: [expect.objectContaining({ id: harness.record.id, state: "installed", enabled: true })],
      }),
    );
    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(true);
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });
});

async function createHarness() {
  const root = join(tmpdir(), `plugin-marketplace-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  const pluginRoot = join(agentDir, "extensions", "dev.meta-agent.reconcile");
  const artifactHash = "a".repeat(64);
  const versionRoot = join(pluginRoot, ".versions", artifactHash);
  const entryPath = join(versionRoot, "payload", "index.ts");
  const source = "export default function reconcile() {}\n";
  await mkdir(join(versionRoot, "payload"), { recursive: true });
  await writeFile(entryPath, source, "utf8");
  const record: InstalledMarketplacePluginRecord = {
    id: "dev.meta-agent.reconcile",
    displayName: "Reconcile Plugin",
    marketplaceId: "local.market",
    version: "1.0.0",
    artifactId: "universal",
    artifactHash,
    enabled: true,
    capabilities: [],
    containsNativeCode: false,
    state: "installed",
    installedAt: 1,
    entryPath,
    rootPath: pluginRoot,
  };
  let operation = 0;
  const registry = new MarketplacePluginRegistry(userDataDir);
  const transactions = new MarketplacePluginTransactionStore(userDataDir, {
    createId: () => `operation-${++operation}`,
    now: () => 100 + operation,
  });
  const reconciler = new MarketplacePluginReconciler(registry, transactions, agentDir, { now: () => 200 });
  return { root, userDataDir, agentDir, versionRoot, record, registry, transactions, reconciler };
}

async function createUpdatedRecord(harness: {
  record: InstalledMarketplacePluginRecord;
}): Promise<InstalledMarketplacePluginRecord> {
  const artifactHash = "b".repeat(64);
  const entryPath = join(harness.record.rootPath, ".versions", artifactHash, "payload", "index.ts");
  const source = "export default function updated() {}\n";
  await mkdir(join(entryPath, ".."), { recursive: true });
  await writeFile(entryPath, source, "utf8");
  return {
    ...harness.record,
    version: "2.0.0",
    artifactId: "universal-v2",
    artifactHash,
    entryPath,
    installedAt: 2,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
