import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceExtensionApplyJournal } from "../src/main/plugins/marketplace-extension-apply-journal.ts";
import { writeMarketplaceProjection } from "../src/main/plugins/marketplace-installed-plugin.ts";
import { MarketplaceMutationApplyCoordinator } from "../src/main/plugins/marketplace-mutation-apply-coordinator.ts";
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

describe("MarketplaceMutationApplyCoordinator", () => {
  it("restores the before registry and projection for a failed update apply", async () => {
    const harness = await createHarness();
    const before = await harness.record("a", "1.0.0");
    const after = await harness.record("b", "2.0.0");
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, before);
    if (installed.status !== "saved") throw new Error("Expected install");
    await writeMarketplaceProjection(before);
    let transaction = await harness.transactions.prepare({
      requestId: "update-apply",
      operation: "update",
      pluginId: before.id,
      before,
      after,
      rootPath: before.rootPath,
      versionPath: join(before.rootPath, ".versions", after.artifactHash),
      removeVersionOnRollback: true,
      removeRootOnRollback: false,
      applyTarget: { projectId: "project", threadId: "thread" },
    });
    const updated = await harness.registry.commitUpdate(installed.snapshot.revision, before.artifactHash, after);
    if (updated.status !== "saved") throw new Error("Expected update");
    await writeMarketplaceProjection(after);
    transaction = await harness.transactions.setPhase(transaction, "projection-committed");

    await harness.coordinator.rollback(transaction.operationId);

    await expect(harness.registry.getInternalSnapshot()).resolves.toEqual(
      expect.objectContaining({ plugins: [expect.objectContaining({ artifactHash: before.artifactHash })] }),
    );
    await expect(readFile(join(before.rootPath, "index.ts"), "utf8")).resolves.toContain(before.artifactHash);
    await expect(harness.transactions.list()).resolves.toEqual([
      expect.objectContaining({ phase: "rollback-pending" }),
    ]);

    await harness.coordinator.complete(transaction.operationId);
    await expect(harness.transactions.list()).resolves.toEqual([]);
    await expect(readFile(after.entryPath, "utf8")).resolves.toContain("2.0.0");
  });

  it("recovers a crash boundary by rolling back mutation state before exposing the worker override", async () => {
    const harness = await createHarness();
    const before = await harness.record("e", "1.0.0");
    const after = await harness.record("f", "2.0.0");
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, before);
    if (installed.status !== "saved") throw new Error("Expected install");
    await writeMarketplaceProjection(before);
    let transaction = await harness.transactions.prepare({
      requestId: "update-crash",
      operation: "update",
      pluginId: before.id,
      before,
      after,
      rootPath: before.rootPath,
      versionPath: join(before.rootPath, ".versions", after.artifactHash),
      removeVersionOnRollback: true,
      removeRootOnRollback: false,
      applyTarget: { projectId: "project", threadId: "thread" },
    });
    const updated = await harness.registry.commitUpdate(installed.snapshot.revision, before.artifactHash, after);
    if (updated.status !== "saved") throw new Error("Expected update");
    await writeMarketplaceProjection(after);
    transaction = await harness.transactions.setPhase(transaction, "projection-committed");
    const references = { retain() {}, release() {} };
    const applyJournal = new MarketplaceExtensionApplyJournal(harness.userDataDir, references, {
      createId: () => "apply-crash",
      mutationLifecycle: harness.coordinator,
    });
    await applyJournal.prepare({
      projectId: "project",
      threadId: "thread",
      beforeSet: extensionSet("before-generation"),
      afterGeneration: "after-generation",
      previousWorkerInstanceId: "old-worker",
      mutationOperationId: transaction.operationId,
    });

    const restarted = new MarketplaceExtensionApplyJournal(harness.userDataDir, references, {
      mutationLifecycle: harness.coordinator,
    });
    await restarted.reconcileStartup();
    await harness.reconciler.reconcile();

    await expect(harness.registry.getInternalSnapshot()).resolves.toEqual(
      expect.objectContaining({ plugins: [expect.objectContaining({ artifactHash: before.artifactHash })] }),
    );
    await expect(harness.transactions.list()).resolves.toEqual([]);
    expect(restarted.getRollbackOverride("project", "thread")).toEqual({
      operationId: "apply-crash",
      extensionSet: expect.objectContaining({ generation: "before-generation" }),
    });
    await restarted.completeStartupRollback("apply-crash");
  });

  it("removes a failed applied install from desired state", async () => {
    const harness = await createHarness();
    const after = await harness.record("c", "1.0.0");
    let transaction = await harness.transactions.prepare({
      requestId: "install-apply",
      operation: "install",
      pluginId: after.id,
      after,
      rootPath: after.rootPath,
      versionPath: join(after.rootPath, ".versions", after.artifactHash),
      removeVersionOnRollback: true,
      removeRootOnRollback: false,
      applyTarget: { projectId: "project", threadId: "thread" },
    });
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, after);
    if (installed.status !== "saved") throw new Error("Expected install");
    await writeMarketplaceProjection(after);
    transaction = await harness.transactions.setPhase(transaction, "projection-committed");

    await harness.coordinator.rollback(transaction.operationId);

    await expect(harness.registry.getInternalSnapshot()).resolves.toEqual(expect.objectContaining({ plugins: [] }));
    await expect(readFile(join(after.rootPath, "index.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(after.rootPath, ".meta-agent-market.json"), "utf8")).resolves.toContain(
      '"state": "uninstalled"',
    );
    await harness.coordinator.complete(transaction.operationId);
    await expect(readFile(after.entryPath, "utf8")).resolves.toContain("1.0.0");
    await expect(harness.transactions.list()).resolves.toEqual([]);
  });

  it("restores an uninstall before state", async () => {
    const harness = await createHarness();
    const before = await harness.record("d", "1.0.0");
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, before);
    if (installed.status !== "saved") throw new Error("Expected install");
    await writeMarketplaceProjection(before);
    let transaction = await harness.transactions.prepare({
      requestId: "uninstall-apply",
      operation: "uninstall",
      pluginId: before.id,
      before,
      rootPath: before.rootPath,
      versionPath: join(before.rootPath, ".versions", before.artifactHash),
      applyTarget: { projectId: "project", threadId: "thread" },
    });
    await harness.registry.commitUninstall(installed.snapshot.revision, before.id);
    transaction = await harness.transactions.setPhase(transaction, "projection-committed");

    await harness.coordinator.rollback(transaction.operationId);

    await expect(harness.registry.getInternalSnapshot()).resolves.toEqual(
      expect.objectContaining({ plugins: [expect.objectContaining({ artifactHash: before.artifactHash })] }),
    );
    await expect(readFile(join(before.rootPath, "index.ts"), "utf8")).resolves.toContain(before.artifactHash);
  });
});

async function createHarness() {
  const root = join(tmpdir(), `marketplace-mutation-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  const pluginRoot = join(agentDir, "extensions", "dev.meta-agent.apply");
  const registry = new MarketplacePluginRegistry(userDataDir);
  let operation = 0;
  const transactions = new MarketplacePluginTransactionStore(userDataDir, {
    createId: () => `operation-${++operation}`,
    now: () => 100,
  });
  const reconciler = new MarketplacePluginReconciler(registry, transactions, agentDir);
  const coordinator = new MarketplaceMutationApplyCoordinator(registry, transactions, reconciler, agentDir, {
    now: () => 200,
  });
  const record = async (hashCharacter: string, version: string): Promise<InstalledMarketplacePluginRecord> => {
    const artifactHash = hashCharacter.repeat(64);
    const source = `export default function plugin() { return ${JSON.stringify(version)}; }\n`;
    const entryPath = join(pluginRoot, ".versions", artifactHash, "payload", "index.ts");
    await mkdir(join(entryPath, ".."), { recursive: true });
    await writeFile(entryPath, source, "utf8");
    return {
      id: "dev.meta-agent.apply",
      displayName: "Apply Plugin",
      marketplaceId: "local.market",
      version,
      artifactId: `artifact-${version}`,
      artifactHash,
      enabled: true,
      capabilities: [],
      containsNativeCode: false,
      state: "installed",
      installedAt: 1,
      entryPath,
      rootPath: pluginRoot,
      verifiedFiles: [
        {
          path: "payload/index.ts",
          sha256: createHash("sha256").update(source).digest("hex"),
          size: Buffer.byteLength(source),
        },
      ],
    };
  };
  return { userDataDir, registry, transactions, reconciler, coordinator, record };
}

function extensionSet(generation: string) {
  return {
    generation,
    projectId: "project",
    entries: [],
    diagnostics: [],
    resolvedAt: 1,
  };
}
