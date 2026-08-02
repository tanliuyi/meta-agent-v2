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
      expect.objectContaining({ id: harness.record.id, state: "installed", enabled: true }),
    ]);
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
      expect.objectContaining({ id: harness.record.id, state: "broken", enabled: false }),
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
      expect.objectContaining({ id: harness.record.id, state: "installed", enabled: true }),
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
  const reconciler = new MarketplacePluginReconciler(registry, agentDir, userDataDir, { now: () => 200 });
  return { root, userDataDir, agentDir, versionRoot, record, registry, reconciler };
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

    expect(installed.snapshot.plugins[0]).toMatchObject({ id: harness.record.id, scope: "global" });
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
    expect(global.snapshot.plugins[0]).toMatchObject({ id: harness.record.id, scope: "global", projectIds: undefined });
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
    expect(project.snapshot.plugins[0]).toMatchObject({ projectIds: ["project-a", "project-b"] });
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
    expect(conflict).toEqual({ status: "conflict", snapshot: installed.snapshot });

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
