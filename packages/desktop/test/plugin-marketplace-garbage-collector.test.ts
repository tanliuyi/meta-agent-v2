import { createHash } from "node:crypto";
import { lstat, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markMarketplaceVersionInactive,
  writeMarketplaceProjection,
  writeMarketplaceUninstallTombstone,
} from "../src/main/plugins/marketplace-installed-plugin.ts";
import { MarketplacePluginGarbageCollector } from "../src/main/plugins/marketplace-plugin-garbage-collector.ts";
import {
  type InstalledMarketplacePluginRecord,
  MarketplacePluginRegistry,
  MISSING_MARKETPLACE_REGISTRY_REVISION,
} from "../src/main/plugins/marketplace-plugin-registry.ts";
import { MarketplacePluginTransactionStore } from "../src/main/plugins/marketplace-plugin-transaction-store.ts";

const roots: string[] = [];
const pluginSource = "export default function plugin() {}\n";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarketplacePluginGarbageCollector", () => {
  it("keeps active and referenced versions while removing expired unreferenced versions", async () => {
    const harness = await createHarness("plugin.active");
    const activeHash = "a".repeat(64);
    const referencedHash = "b".repeat(64);
    const removableHash = "c".repeat(64);
    const active = await createVersion(harness.pluginRoot, activeHash);
    const referenced = await createVersion(harness.pluginRoot, referencedHash);
    const removable = await createVersion(harness.pluginRoot, removableHash);
    const record = installedRecord(harness.pluginRoot, activeHash, join(active, "payload", "index.ts"));
    await writeMarketplaceProjection(
      installedRecord(harness.pluginRoot, referencedHash, join(referenced, "payload", "index.ts")),
    );
    await writeMarketplaceProjection(
      installedRecord(harness.pluginRoot, removableHash, join(removable, "payload", "index.ts")),
    );
    await writeMarketplaceProjection(record);
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, record);
    let referenceHeld = true;
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: (path) => referenceHeld && path === referenced },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    const first = await collector.run();

    expect(first.removedVersions).toEqual([removable]);
    await expect(directoryExists(active)).resolves.toBe(true);
    await expect(directoryExists(referenced)).resolves.toBe(true);
    referenceHeld = false;
    const second = await collector.run();
    expect(second.removedVersions).toEqual([referenced]);
    await expect(directoryExists(active)).resolves.toBe(true);
  });

  it("bases retention on a persisted main-owned inactivity timestamp rather than directory mtime", async () => {
    const harness = await createHarness("plugin.retention");
    const activeHash = "3".repeat(64);
    const inactiveHash = "4".repeat(64);
    const active = await createVersion(harness.pluginRoot, activeHash);
    const inactive = await createVersion(harness.pluginRoot, inactiveHash);
    const activeRecord = installedRecord(harness.pluginRoot, activeHash, join(active, "payload", "index.ts"));
    const inactiveRecord = installedRecord(harness.pluginRoot, inactiveHash, join(inactive, "payload", "index.ts"));
    await writeMarketplaceProjection(inactiveRecord);
    await markMarketplaceVersionInactive(inactiveRecord, 9_000);
    await writeMarketplaceProjection(activeRecord);
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, activeRecord);

    const firstCollector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 2_000 },
    );
    await expect(firstCollector.run()).resolves.toMatchObject({ removedVersions: [] });
    await expect(directoryExists(inactive)).resolves.toBe(true);

    const restartedCollector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 11_001, retentionMs: 2_000 },
    );
    await expect(restartedCollector.run()).resolves.toMatchObject({ removedVersions: [inactive] });
  });

  it("preserves an unreferenced version whose signed files were modified", async () => {
    const harness = await createHarness("plugin.modified-old-version");
    const activeHash = "1".repeat(64);
    const modifiedHash = "2".repeat(64);
    const active = await createVersion(harness.pluginRoot, activeHash);
    const modified = await createVersion(harness.pluginRoot, modifiedHash);
    const activeRecord = installedRecord(harness.pluginRoot, activeHash, join(active, "payload", "index.ts"));
    const modifiedRecord = installedRecord(harness.pluginRoot, modifiedHash, join(modified, "payload", "index.ts"));
    await writeMarketplaceProjection(modifiedRecord);
    await writeMarketplaceProjection(activeRecord);
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, activeRecord);
    await writeFile(join(modified, "payload", "index.ts"), "modified by user\n", "utf8");
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    const result = await collector.run();

    expect(result.removedVersions).toEqual([]);
    expect(result.preservedModifiedRoots).toEqual([harness.pluginRoot]);
    await expect(directoryExists(modified)).resolves.toBe(true);
  });

  it("removes an expired uninstalled root only after all references are released", async () => {
    const harness = await createHarness("plugin.uninstalled");
    const artifactHash = "d".repeat(64);
    const versionRoot = await createVersion(harness.pluginRoot, artifactHash);
    const record = installedRecord(harness.pluginRoot, artifactHash, join(versionRoot, "payload", "index.ts"));
    await writeMarketplaceProjection(record);
    await writeMarketplaceUninstallTombstone(record, "uninstall", 1, false);
    let referenced = true;
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: (path) => referenced && path === versionRoot },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    await collector.run();
    await expect(directoryExists(harness.pluginRoot)).resolves.toBe(true);
    referenced = false;
    const result = await collector.run();

    expect(result.removedVersions).toEqual([versionRoot]);
    expect(result.removedRoots).toEqual([harness.pluginRoot]);
    await expect(directoryExists(harness.pluginRoot)).resolves.toBe(false);
  });

  it("removes an orphaned empty root left by an interrupted teardown", async () => {
    const harness = await createHarness("plugin.orphan");
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    const result = await collector.run();

    expect(result.removedRoots).toEqual([harness.pluginRoot]);
    await expect(directoryExists(harness.pluginRoot)).resolves.toBe(false);
  });

  it("keeps a tombstone-less root that still has content", async () => {
    const harness = await createHarness("plugin.unknown");
    await writeFile(join(harness.pluginRoot, "user-note.txt"), "preserve me", "utf8");
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    const result = await collector.run();

    expect(result.removedRoots).toEqual([]);
    await expect(directoryExists(harness.pluginRoot)).resolves.toBe(true);
  });

  it("resumes an interrupted root teardown that only has a tombstone left", async () => {
    const harness = await createHarness("plugin.resumed");
    const artifactHash = "f".repeat(64);
    const record = installedRecord(
      harness.pluginRoot,
      artifactHash,
      join(harness.pluginRoot, ".versions", artifactHash, "payload", "index.ts"),
    );
    await writeMarketplaceUninstallTombstone(record, "uninstall", 1, false);
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    const result = await collector.run();

    expect(result.removedRoots).toEqual([harness.pluginRoot]);
    await expect(directoryExists(harness.pluginRoot)).resolves.toBe(false);
  });

  it("never collects a tombstone that preserves user-modified files", async () => {
    const harness = await createHarness("plugin.modified");
    const artifactHash = "e".repeat(64);
    const versionRoot = await createVersion(harness.pluginRoot, artifactHash);
    const record = installedRecord(harness.pluginRoot, artifactHash, join(versionRoot, "payload", "index.ts"));
    await writeMarketplaceProjection(record);
    await writeMarketplaceUninstallTombstone(record, "uninstall", 1, true);
    const collector = new MarketplacePluginGarbageCollector(
      harness.registry,
      harness.transactions,
      { isReferenced: () => false },
      harness.agentDir,
      { now: () => 10_000, retentionMs: 0 },
    );

    const result = await collector.run();

    expect(result.preservedModifiedRoots).toEqual([harness.pluginRoot]);
    await expect(directoryExists(versionRoot)).resolves.toBe(true);
  });
});

async function createHarness(pluginId: string) {
  const root = join(tmpdir(), `marketplace-gc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const userDataDir = join(root, "user-data");
  const agentDir = join(root, "agent");
  const pluginRoot = join(agentDir, "extensions", pluginId);
  await mkdir(pluginRoot, { recursive: true });
  return {
    root,
    userDataDir,
    agentDir,
    pluginRoot,
    registry: new MarketplacePluginRegistry(userDataDir),
    transactions: new MarketplacePluginTransactionStore(userDataDir),
  };
}

async function createVersion(pluginRoot: string, artifactHash: string): Promise<string> {
  const versionRoot = join(pluginRoot, ".versions", artifactHash);
  const entry = join(versionRoot, "payload", "index.ts");
  await mkdir(join(versionRoot, "payload"), { recursive: true });
  await writeFile(entry, pluginSource, "utf8");
  await utimes(versionRoot, new Date(1), new Date(1));
  return versionRoot;
}

function installedRecord(
  pluginRoot: string,
  artifactHash: string,
  entryPath: string,
): InstalledMarketplacePluginRecord {
  return {
    id: basename(pluginRoot),
    displayName: "Plugin",
    marketplaceId: "example.market",
    version: "1.0.0",
    artifactId: "artifact",
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
        sha256: createHash("sha256").update(pluginSource).digest("hex"),
        size: Buffer.byteLength(pluginSource),
      },
    ],
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
