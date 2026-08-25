import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMarketplaceVersionOwner,
  writeMarketplaceBrokenMarker,
  writeMarketplaceProjection,
} from "../src/main/plugins/marketplace-installed-plugin.ts";
import { MarketplacePluginReconciler } from "../src/main/plugins/marketplace-plugin-reconciler.ts";
import {
  type InstalledMarketplacePluginRecord,
  MarketplacePluginRegistry,
  MISSING_MARKETPLACE_REGISTRY_REVISION,
} from "../src/main/plugins/marketplace-plugin-registry.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarketplacePluginReconciler", () => {
  it("rewrites a missing projection after a committed registry entry", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    await harness.reconciler.reconcile();

    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toContain(
      `./.versions/${harness.record.artifactHash}/payload/index.ts`,
    );
    await expect(harness.registry.getSnapshot()).resolves.toEqual(installed.snapshot);
  });

  it("keeps a committed plugin untouched when its projection and entry exist", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    await writeFile(join(harness.record.rootPath, "index.ts"), "export { default } from './custom.ts';\n", "utf8");

    await harness.reconciler.reconcile();

    // A present projection is never overwritten; only missing ones are repaired.
    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toBe(
      "export { default } from './custom.ts';\n",
    );
    const snapshot = await harness.registry.getInternalSnapshot();
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({
        id: harness.record.id,
        state: "installed",
        enabled: true,
      }),
    ]);
  });

  it("migrates a Desktop-owned plugin from the legacy Pi extension root", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    const logs: string[] = [];
    const marketplaceRoot = join(harness.root, "desktop-marketplace-root");
    const reconciler = new MarketplacePluginReconciler(harness.registry, marketplaceRoot, harness.userDataDir, {
      log: (message) => logs.push(message),
    });

    await reconciler.reconcile();

    const migratedRoot = join(marketplaceRoot, harness.record.id);
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [
        {
          id: harness.record.id,
          rootPath: migratedRoot,
          entryPath: join(migratedRoot, ".versions", harness.record.artifactHash, "payload", "index.ts"),
          state: "installed",
          enabled: true,
        },
      ],
    });
    await expect(pathExists(harness.record.rootPath)).resolves.toBe(false);
    await expect(readFile(join(migratedRoot, "index.ts"), "utf8")).resolves.toContain(harness.record.artifactHash);
    expect(logs).toContain(`Migrated marketplace plugin ${harness.record.id} into the Desktop managed root`);
  });

  it("preserves a disabled plugin state during migration", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    const disabled = await harness.registry.commitEnabled(installed.snapshot.revision, harness.record.id, false);
    if (disabled.status !== "saved") throw new Error("Expected plugin disable");
    const marketplaceRoot = join(harness.root, "desktop-marketplace-root");

    await new MarketplacePluginReconciler(harness.registry, marketplaceRoot, harness.userDataDir).reconcile();

    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, rootPath: join(marketplaceRoot, harness.record.id), enabled: false }],
    });
  });

  it("does not move an invalid legacy payload", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    await rm(harness.record.entryPath, { force: true });
    const marketplaceRoot = join(harness.root, "desktop-marketplace-root");

    await new MarketplacePluginReconciler(harness.registry, marketplaceRoot, harness.userDataDir).reconcile();

    await expect(pathExists(harness.record.rootPath)).resolves.toBe(true);
    await expect(pathExists(join(marketplaceRoot, harness.record.id))).resolves.toBe(false);
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, rootPath: harness.record.rootPath, state: "broken", enabled: false }],
    });
  });

  it("migrates a legacy plugin that an intermediate Desktop version marked broken", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    await harness.registry.markBroken(harness.record.id, harness.record.artifactHash);
    await writeMarketplaceBrokenMarker({ ...harness.record, state: "broken", enabled: false });
    const marketplaceRoot = join(harness.root, "desktop-marketplace-root");

    await new MarketplacePluginReconciler(harness.registry, marketplaceRoot, harness.userDataDir).reconcile();

    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, rootPath: join(marketplaceRoot, harness.record.id), state: "installed" }],
    });
    await expect(pathExists(harness.record.rootPath)).resolves.toBe(false);
  });

  it("recovers when the legacy root moved before the registry commit", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    const marketplaceRoot = join(harness.root, "desktop-marketplace-root");
    const migratedRoot = join(marketplaceRoot, harness.record.id);
    await cp(harness.record.rootPath, migratedRoot, { recursive: true });
    await rm(harness.record.rootPath, { recursive: true, force: true });

    await new MarketplacePluginReconciler(harness.registry, marketplaceRoot, harness.userDataDir).reconcile();

    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, rootPath: migratedRoot, state: "installed", enabled: true }],
    });
    await expect(readFile(join(migratedRoot, "index.ts"), "utf8")).resolves.toContain(harness.record.artifactHash);
  });

  it("keeps unrelated files when an out-of-root record has no matching ownership", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    const projection = join(harness.record.rootPath, "index.ts");
    await writeFile(projection, "user-owned content\n", "utf8");
    const reconciler = new MarketplacePluginReconciler(
      harness.registry,
      join(harness.root, "temporary-marketplace-root"),
      harness.userDataDir,
    );

    await reconciler.reconcile();

    await expect(readFile(projection, "utf8")).resolves.toBe("user-owned content\n");
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, state: "broken", enabled: false }],
    });
  });

  it("marks a stale registry entry broken after its old managed root is removed", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await rm(harness.agentDir, { recursive: true, force: true });
    const logs: string[] = [];
    const temporaryMarketplaceRoot = join(harness.root, "temporary-marketplace-root");
    const reconciler = new MarketplacePluginReconciler(
      harness.registry,
      temporaryMarketplaceRoot,
      harness.userDataDir,
      {
        log: (message) => logs.push(message),
      },
    );

    await reconciler.reconcile();

    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, state: "broken", enabled: false }],
    });
    expect(logs).toEqual([
      expect.stringContaining(`Marked marketplace plugin broken while reconciling ${harness.record.id}`),
    ]);
  });

  it("accepts an equivalent agent directory reached through a filesystem alias", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    const aliasedMarketplaceRoot = join(harness.root, "aliased-marketplace-root");
    await symlink(
      join(harness.agentDir, "extensions"),
      aliasedMarketplaceRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const logs: string[] = [];
    const reconciler = new MarketplacePluginReconciler(harness.registry, aliasedMarketplaceRoot, harness.userDataDir, {
      log: (message) => logs.push(message),
    });

    await reconciler.reconcile();

    await expect(harness.registry.getSnapshot()).resolves.toEqual(installed.snapshot);
    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(true);
    expect(logs).toEqual([]);
  });

  it("repairs a broken plugin when its managed payload is intact", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    await harness.registry.markBroken(harness.record.id, harness.record.artifactHash);
    await writeMarketplaceBrokenMarker({
      ...harness.record,
      state: "broken",
      enabled: false,
    });

    await harness.reconciler.reconcile();

    const snapshot = await harness.registry.getInternalSnapshot();
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({
        id: harness.record.id,
        state: "installed",
        enabled: true,
      }),
    ]);
    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toContain(
      `./.versions/${harness.record.artifactHash}/payload/index.ts`,
    );
    expect(JSON.parse(await readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8"))).toMatchObject({
      version: 1,
      state: "installed",
    });
  });

  it("rewrites a stale projection that belongs to a different artifact", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    const markerPath = join(harness.record.rootPath, ".meta-agent-market.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.record.artifactHash = "b".repeat(64);
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await writeFile(join(harness.record.rootPath, "index.ts"), "export { default } from './old.ts';\n", "utf8");

    await harness.reconciler.reconcile();

    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toContain(
      `./.versions/${harness.record.artifactHash}/payload/index.ts`,
    );
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({
      state: "installed",
      record: { artifactHash: harness.record.artifactHash },
    });
  });

  it("marks a committed plugin broken when its version payload is missing", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    await writeMarketplaceProjection(harness.record);
    await rm(harness.versionRoot, { recursive: true, force: true });

    await harness.reconciler.reconcile();

    const snapshot = await harness.registry.getInternalSnapshot();
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({
        id: harness.record.id,
        state: "broken",
        enabled: false,
      }),
    ]);
    expect(JSON.parse(await readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8"))).toMatchObject({
      version: 1,
      state: "broken",
    });
    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(false);
  });

  it("keeps a committed plugin active when its entry bytes change", async () => {
    const harness = await createHarness();
    await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    await writeMarketplaceProjection(harness.record);
    await writeFile(harness.record.entryPath, "modified\n", "utf8");

    await harness.reconciler.reconcile();

    const snapshot = await harness.registry.getInternalSnapshot();
    expect(snapshot.plugins).toEqual([
      expect.objectContaining({
        id: harness.record.id,
        state: "installed",
        enabled: true,
      }),
    ]);
    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(true);
  });

  it("completes an interrupted uninstall by writing the tombstone for an unowned installed root", async () => {
    const harness = await createHarness();
    await writeMarketplaceProjection(harness.record);

    await harness.reconciler.reconcile();
    await harness.reconciler.reconcile();

    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(false);
    expect(JSON.parse(await readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8"))).toMatchObject({
      version: 1,
      state: "uninstalled",
      pluginId: harness.record.id,
      artifactHash: harness.record.artifactHash,
    });
    await expect(readMarketplaceVersionOwner(harness.record.rootPath, harness.record.artifactHash)).resolves.toEqual({
      record: harness.record,
      inactiveAt: 200,
    });
  });

  it("does not use a marker record that points at a different root to write anywhere else", async () => {
    const harness = await createHarness();
    const externalTarget = join(harness.root, "external-target");
    await mkdir(externalTarget, { recursive: true });
    await writeFile(join(externalTarget, "index.ts"), "external content\n", "utf8");
    const maliciousRoot = join(harness.agentDir, "extensions", harness.record.id);
    await mkdir(maliciousRoot, { recursive: true });
    await writeFile(join(maliciousRoot, "index.ts"), "managed content\n", "utf8");
    await writeFile(
      join(maliciousRoot, ".meta-agent-market.json"),
      `${JSON.stringify(
        {
          version: 1,
          state: "installed",
          record: {
            id: harness.record.id,
            artifactHash: "b".repeat(64),
            rootPath: externalTarget,
            entryPath: join(externalTarget, "index.ts"),
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await harness.reconciler.reconcile();

    // 外部目标完全不被触碰：既不移除 projection，也不写 tombstone/version owner。
    await expect(readFile(join(externalTarget, "index.ts"), "utf8")).resolves.toBe("external content\n");
    await expect(pathExists(join(externalTarget, ".meta-agent-market.json"))).resolves.toBe(false);
    await expect(pathExists(join(externalTarget, ".meta-agent-versions"))).resolves.toBe(false);
    // 扫描根目录本身也保持原样（不猜测、不删除）。
    await expect(readFile(join(maliciousRoot, "index.ts"), "utf8")).resolves.toBe("managed content\n");
    await expect(pathExists(maliciousRoot)).resolves.toBe(true);
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({ plugins: [] });
  });

  it("does not trust a marker whose plugin id or entry path does not describe the scanned root", async () => {
    const harness = await createHarness();
    const scannedRoot = join(harness.agentDir, "extensions", harness.record.id);
    await mkdir(scannedRoot, { recursive: true });
    await writeFile(join(scannedRoot, "index.ts"), "kept\n", "utf8");
    const entryOutside = join(harness.root, "outside", "index.ts");
    for (const record of [
      // 目录名与 record.id 不符。
      { ...harness.record, id: "dev.meta-agent.other" },
      // id/rootPath 正确但 entryPath 逃逸出扫描根。
      { ...harness.record, entryPath: entryOutside },
      // artifactHash 不可作为版本目录名（不能允许路径穿越或非摘要值）。
      { ...harness.record, artifactHash: "../outside" },
      // entryPath 虽在插件根内，但不属于声明 hash 的不可变版本目录。
      { ...harness.record, entryPath: join(scannedRoot, "index.ts") },
    ]) {
      await writeFile(
        join(scannedRoot, ".meta-agent-market.json"),
        `${JSON.stringify({ version: 1, state: "installed", record }, null, 2)}\n`,
        "utf8",
      );

      await harness.reconciler.reconcile();

      await expect(readFile(join(scannedRoot, "index.ts"), "utf8")).resolves.toBe("kept\n");
      await expect(readFile(join(scannedRoot, ".meta-agent-market.json"), "utf8")).resolves.toContain('"installed"');
    }
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({ plugins: [] });
  });

  it("preserves a bound marker when its version payload cannot be validated", async () => {
    const harness = await createHarness();
    const scannedRoot = join(harness.agentDir, "extensions", harness.record.id);
    await mkdir(scannedRoot, { recursive: true });
    await writeFile(join(scannedRoot, "index.ts"), "foreign content\n", "utf8");
    await writeFile(
      join(scannedRoot, ".meta-agent-market.json"),
      `${JSON.stringify({ version: 1, state: "broken", record: harness.record }, null, 2)}\n`,
      "utf8",
    );
    await rm(harness.record.entryPath, { force: true });

    await harness.reconciler.reconcile();

    await expect(readFile(join(scannedRoot, "index.ts"), "utf8")).resolves.toBe("foreign content\n");
    await expect(readFile(join(scannedRoot, ".meta-agent-market.json"), "utf8")).resolves.toContain('"broken"');
    await expect(pathExists(join(scannedRoot, ".meta-agent-versions"))).resolves.toBe(false);
  });

  it("completes an interrupted uninstall left in the legacy root after the managed root moved", async () => {
    const harness = await createHarness();
    await writeMarketplaceProjection(harness.record);
    const managedRoot = join(harness.userDataDir, "plugins", "extensions");
    const reconciler = new MarketplacePluginReconciler(harness.registry, managedRoot, harness.userDataDir, {
      legacyRoot: join(harness.agentDir, "extensions"),
      now: () => 200,
    });

    await reconciler.reconcile();

    await expect(pathExists(join(harness.record.rootPath, "index.ts"))).resolves.toBe(false);
    expect(JSON.parse(await readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8"))).toMatchObject({
      version: 1,
      state: "uninstalled",
      pluginId: harness.record.id,
      artifactHash: harness.record.artifactHash,
    });
    await expect(readMarketplaceVersionOwner(harness.record.rootPath, harness.record.artifactHash)).resolves.toEqual({
      record: harness.record,
      inactiveAt: 200,
    });
    await expect(pathExists(join(managedRoot, harness.record.id))).resolves.toBe(false);
  });

  it("never deletes unknown or foreign content in the legacy root", async () => {
    const harness = await createHarness();
    const legacyRoot = harness.agentDir;
    const foreignPlugin = join(legacyRoot, "extensions", "dev.user.foreign");
    await mkdir(foreignPlugin, { recursive: true });
    await writeFile(join(foreignPlugin, "index.ts"), "user extension\n", "utf8");
    const stray = join(legacyRoot, "extensions", "com.example.stray");
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "index.ts"), "stray\n", "utf8");
    await writeFile(
      join(stray, ".meta-agent-market.json"),
      `${JSON.stringify(
        {
          version: 1,
          state: "installed",
          record: { ...harness.record, id: "com.example.other", rootPath: stray },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    // 绑定到目录但 payload 已损坏（entry 缺失）：不是完整的 Marketplace 产物，不补完卸载。
    const brokenPayload = join(legacyRoot, "extensions", harness.record.id);
    await mkdir(join(brokenPayload, ".versions", harness.record.artifactHash, "payload"), { recursive: true });
    await writeMarketplaceProjection(harness.record);
    await rm(harness.record.entryPath, { force: true });

    const managedRoot = join(harness.userDataDir, "plugins", "extensions");
    const reconciler = new MarketplacePluginReconciler(harness.registry, managedRoot, harness.userDataDir, {
      legacyRoot: join(legacyRoot, "extensions"),
      now: () => 200,
    });

    await reconciler.reconcile();

    await expect(readFile(join(foreignPlugin, "index.ts"), "utf8")).resolves.toBe("user extension\n");
    await expect(readFile(join(stray, "index.ts"), "utf8")).resolves.toBe("stray\n");
    await expect(readFile(join(harness.record.rootPath, "index.ts"), "utf8")).resolves.toBe(
      `export { default } from "./.versions/${harness.record.artifactHash}/payload/index.ts";\n`,
    );
    await expect(readFile(join(harness.record.rootPath, ".meta-agent-market.json"), "utf8")).resolves.toContain(
      '"installed"',
    );
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({ plugins: [] });
  });

  it("removes an uncommitted orphan version payload that only fills the managed root", async () => {
    const harness = await createHarness();

    await harness.reconciler.reconcile();

    await expect(pathExists(harness.versionRoot)).resolves.toBe(false);
    await expect(pathExists(harness.record.rootPath)).resolves.toBe(false);
    await expect(harness.registry.getSnapshot()).resolves.toEqual({
      revision: MISSING_MARKETPLACE_REGISTRY_REVISION,
      plugins: [],
    });
  });

  it("preserves unowned roots that contain user content", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.record.rootPath, "user-note.txt"), "preserve me", "utf8");

    await harness.reconciler.reconcile();

    await expect(pathExists(harness.record.rootPath)).resolves.toBe(true);
    await expect(readFile(join(harness.record.rootPath, "user-note.txt"), "utf8")).resolves.toBe("preserve me");
  });

  it("cleans staging orphans and the legacy transaction journal", async () => {
    const harness = await createHarness();
    const stagingRoot = join(harness.agentDir, "extensions", ".meta-agent-marketplace-staging");
    const orphan = join(stagingRoot, `${harness.record.id}-orphan`);
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "partial"), "partial", "utf8");
    await writeFile(join(stagingRoot, "README"), "unknown", "utf8");
    const journal = join(harness.userDataDir, "plugins", "transactions");
    await mkdir(journal, { recursive: true });
    await writeFile(join(journal, "old.json"), "{}\n", "utf8");

    await harness.reconciler.reconcile();

    await expect(pathExists(orphan)).resolves.toBe(false);
    await expect(readFile(join(stagingRoot, "README"), "utf8")).resolves.toBe("unknown");
    await expect(pathExists(journal)).resolves.toBe(false);
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
  const registry = new MarketplacePluginRegistry(userDataDir);
  const reconciler = new MarketplacePluginReconciler(registry, join(agentDir, "extensions"), userDataDir, {
    now: () => 200,
  });
  return {
    root,
    userDataDir,
    agentDir,
    versionRoot,
    record,
    registry,
    reconciler,
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

describe("MarketplacePluginRegistry scope", () => {
  it("normalizes legacy records without a scope field to global", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    expect(installed.snapshot.plugins[0]).toMatchObject({
      id: harness.record.id,
      scope: "global",
    });
    await expect(harness.registry.getInternalSnapshot()).resolves.toMatchObject({
      plugins: [{ id: harness.record.id, scope: "global" }],
    });
  });

  it("migrates legacy single-project records to a project list", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");
    const file = JSON.parse(await readFile(harness.registry.path, "utf8"));
    file.plugins[0].scope = "project";
    file.plugins[0].projectId = "legacy-project";
    await writeFile(harness.registry.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");

    const snapshot = await harness.registry.getInternalSnapshot();

    expect(snapshot.plugins[0]).toMatchObject({
      id: harness.record.id,
      scope: "project",
      projectIds: ["legacy-project"],
      projectId: undefined,
    });
  });

  it("switches an installed plugin between enabled and disabled", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    const disabled = await harness.registry.commitEnabled(installed.snapshot.revision, harness.record.id, false);
    expect(disabled).toMatchObject({ status: "saved" });
    if (disabled.status !== "saved") throw new Error("Expected enabled-state commit");
    expect(disabled.snapshot.plugins[0]).toMatchObject({
      id: harness.record.id,
      enabled: false,
    });

    const enabled = await harness.registry.commitEnabled(disabled.snapshot.revision, harness.record.id, true);
    expect(enabled).toMatchObject({ status: "saved" });
    if (enabled.status !== "saved") throw new Error("Expected enabled-state commit");
    expect(enabled.snapshot.plugins[0]).toMatchObject({
      id: harness.record.id,
      enabled: true,
    });
  });

  it("reports conflict, broken and not-installed enabled-state commits", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    await expect(
      harness.registry.commitEnabled(installed.snapshot.revision, harness.record.id, "yes" as never),
    ).rejects.toThrow("enabled state is invalid");
    await expect(harness.registry.commitEnabled("stale-revision", harness.record.id, false)).resolves.toEqual({
      status: "conflict",
      snapshot: installed.snapshot,
    });
    await expect(
      harness.registry.commitEnabled(installed.snapshot.revision, "missing.plugin", false),
    ).resolves.toMatchObject({
      status: "not-installed",
    });

    await harness.registry.markBroken(harness.record.id, harness.record.artifactHash);
    const broken = await harness.registry.getSnapshot();
    await expect(harness.registry.commitEnabled(broken.revision, harness.record.id, true)).resolves.toMatchObject({
      status: "broken",
      snapshot: broken,
    });
  });

  it("switches an installed plugin between global and project scope", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    const project = await harness.registry.commitScope(installed.snapshot.revision, harness.record.id, "project", [
      "project-a",
      "project-b",
    ]);
    expect(project).toMatchObject({ status: "saved" });
    if (project.status !== "saved") throw new Error("Expected scope commit");
    expect(project.snapshot.plugins[0]).toMatchObject({
      id: harness.record.id,
      scope: "project",
      projectIds: ["project-a", "project-b"],
    });

    const global = await harness.registry.commitScope(
      project.snapshot.revision,
      harness.record.id,
      "global",
      undefined,
    );
    expect(global).toMatchObject({ status: "saved" });
    if (global.status !== "saved") throw new Error("Expected scope commit");
    expect(global.snapshot.plugins[0]).toMatchObject({
      id: harness.record.id,
      scope: "global",
      projectIds: undefined,
    });
  });

  it("deduplicates project IDs in a project-scoped commit", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    const project = await harness.registry.commitScope(installed.snapshot.revision, harness.record.id, "project", [
      "project-a",
      "project-b",
      "project-a",
    ]);
    expect(project).toMatchObject({ status: "saved" });
    if (project.status !== "saved") throw new Error("Expected scope commit");
    expect(project.snapshot.plugins[0]).toMatchObject({
      projectIds: ["project-a", "project-b"],
    });
  });

  it("rejects a project scope without projects or with invalid IDs", async () => {
    const harness = await createHarness();
    await expect(harness.registry.commitScope("revision", harness.record.id, "project", undefined)).rejects.toThrow(
      "at least one project",
    );
    await expect(harness.registry.commitScope("revision", harness.record.id, "project", [])).rejects.toThrow(
      "at least one project",
    );
    await expect(harness.registry.commitScope("revision", harness.record.id, "project", [""])).rejects.toThrow(
      "invalid project ID",
    );
    await expect(
      harness.registry.commitScope("revision", harness.record.id, "project", [123] as unknown as string[]),
    ).rejects.toThrow("invalid project ID");
    await expect(harness.registry.commitScope("revision", harness.record.id, "invalid", undefined)).rejects.toThrow(
      "scope is invalid",
    );
  });

  it("reports conflict and not-installed scope commits without touching other plugins", async () => {
    const harness = await createHarness();
    const installed = await harness.registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, harness.record);
    if (installed.status !== "saved") throw new Error("Expected registry install");

    const conflict = await harness.registry.commitScope("stale-revision", harness.record.id, "global", undefined);
    expect(conflict).toEqual({
      status: "conflict",
      snapshot: installed.snapshot,
    });

    const missing = await harness.registry.commitScope(
      installed.snapshot.revision,
      "missing.plugin",
      "global",
      undefined,
    );
    expect(missing).toMatchObject({ status: "not-installed" });
    await expect(harness.registry.getSnapshot()).resolves.toEqual(installed.snapshot);
  });
});
