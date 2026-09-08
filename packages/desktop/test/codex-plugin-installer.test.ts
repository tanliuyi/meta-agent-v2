import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexPluginInstaller,
  defaultCachebusterToken,
  deriveUpdateVersion,
  hashCodexPluginRoot,
} from "../src/main/plugins/codex/codex-plugin-installer.ts";
import { CodexPluginReconciler } from "../src/main/plugins/codex/codex-plugin-reconciler.ts";
import type { CodexPluginRegistryRecord } from "../src/main/plugins/codex/codex-plugin-registry.ts";
import { CodexPluginRegistry } from "../src/main/plugins/codex/codex-plugin-registry.ts";
import { discoverCodexPluginSources } from "../src/main/plugins/codex/codex-plugin-sources.ts";

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0); // 2026-09-07T12:00:00Z

interface Harness {
  root: string;
  homeDir: string;
  userDataDir: string;
  codexRoot: string;
  registry: CodexPluginRegistry;
  installer: CodexPluginInstaller;
  revision: string;
  addPlugin(overrides?: { version?: string; file?: string; content?: string }): Promise<string>;
  refreshDiscovery(): Promise<string>;
  mutatePlugin(pluginId: string, file: string, content: string): Promise<void>;
  record(pluginId: string): Promise<CodexPluginRegistryRecord | undefined>;
  payloadFiles(pluginId: string, hash: string): Promise<string[]>;
}

describe("codex-plugin-installer", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createHarness(
    options: { beforeRegistryCommit?(rootPath: string, versionPath: string): Promise<void> } = {},
  ): Promise<Harness> {
    const root = join(tmpdir(), `codex-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const homeDir = join(root, "home");
    const userDataDir = join(root, "userData");
    await mkdir(join(homeDir, ".agents", "plugins"), { recursive: true });
    await writeFile(
      join(homeDir, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify(
        {
          name: "personal",
          plugins: [{ name: "my-tool", source: { source: "local", path: "./plugins/my-tool" } }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const registry = new CodexPluginRegistry(userDataDir);
    const codexRoot = join(userDataDir, "plugins", "codex-extensions");
    const installer = new CodexPluginInstaller(registry, join(userDataDir, "plugins", "locks"), codexRoot, {
      now: () => NOW,
      ...(options.beforeRegistryCommit ? { beforeRegistryCommit: options.beforeRegistryCommit } : {}),
    });
    const harness: Harness = {
      root,
      homeDir,
      userDataDir,
      codexRoot,
      registry,
      installer,
      revision: "",
      async addPlugin(overrides = {}) {
        const pluginRoot = join(homeDir, "plugins", "my-tool");
        await writeCodexPluginSource(pluginRoot, overrides.version ?? "0.1.0");
        await writeFile(join(pluginRoot, "buffer.js"), overrides.content ?? "export function ping() {}\n", "utf8");
        if (overrides.file) await writeFile(join(pluginRoot, overrides.file), "", "utf8");
        await harness.refreshDiscovery();
        return pluginRoot;
      },
      async refreshDiscovery() {
        const snapshot = await registry.reconcile((await discoverCodexPluginSources(homeDir)).plugins);
        harness.revision = snapshot.revision;
        return snapshot.revision;
      },
      async mutatePlugin(_pluginId, file, content) {
        await writeFile(join(homeDir, "plugins", "my-tool", file), content, "utf8");
      },
      async record(pluginId) {
        const snapshot = await registry.getSnapshot();
        return snapshot.plugins.find((plugin) => plugin.id === pluginId);
      },
      async payloadFiles(pluginId, hash) {
        const versionDir = join(codexRoot, pluginId, ".versions", hash);
        return (await readdir(versionDir, { recursive: true })).map((path) => path.replaceAll("\\", "/")).sort();
      },
    };
    await harness.refreshDiscovery();
    return harness;
  }

  describe("deriveUpdateVersion", () => {
    const record = (version: string) => ({ version }) as unknown as CodexPluginRegistryRecord;

    it("keeps the source version when the base version changed", () => {
      expect(deriveUpdateVersion(record("0.1.0"), "0.2.0", NOW)).toBe("0.2.0");
    });

    it("derives a cachebuster suffix when the base version is unchanged", () => {
      expect(deriveUpdateVersion(record("0.1.0"), "0.1.0", NOW)).toBe("0.1.0+codex.20260907120000");
    });

    it("replaces an existing cachebuster suffix instead of stacking", () => {
      expect(deriveUpdateVersion(record("0.1.0+codex.20260101000000"), "0.1.0", NOW)).toBe(
        "0.1.0+codex.20260907120000",
      );
    });

    it("keeps a source version that already bumps its base", () => {
      expect(deriveUpdateVersion(record("0.1.0+codex.20260101000000"), "0.2.0", NOW)).toBe("0.2.0");
    });

    it("replaces a source-provided cachebuster suffix on a content change", () => {
      // 源 manifest 自带 +codex. 后缀（开发者用 Codex CLI 更新过）：base 相同则按缓存清除替换后缀
      expect(deriveUpdateVersion(record("0.1.0"), "0.1.0+codex.20260101120000", NOW)).toBe(
        "0.1.0+codex.20260907120000",
      );
    });
  });

  it("uses the Codex UTC timestamp format for default cachebuster tokens", () => {
    expect(defaultCachebusterToken(NOW)).toBe("20260907120000");
  });

  it("installs a discovered plugin as a content-addressed managed copy", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const result = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-1",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(result.status).toBe("installed");
    if (result.status !== "installed") return;
    const record = harness.registry.getSnapshot().then((s) => s.plugins.find((p) => p.id === "my-tool"));
    const installed = await record;
    expect(installed?.installedHash).toBeDefined();
    expect(installed?.installedRootPath).toBe(join(harness.codexRoot, "my-tool"));
    expect(installed?.version).toBe("0.1.0");
    const hash = installed?.installedHash;
    if (!hash) return;
    const files = await harness.payloadFiles("my-tool", hash);
    expect(files).toEqual([
      ".codex-plugin",
      ".codex-plugin/plugin.json",
      "buffer.js",
      "skills",
      "skills/demo",
      "skills/demo/SKILL.md",
    ]);
    expect(await hashCodexPluginRoot(join(harness.homeDir, "plugins", "my-tool"))).toBe(hash);
  });

  it("frames file paths and contents when hashing", async () => {
    const harness = await createHarness();
    const left = join(harness.root, "hash-left");
    const right = join(harness.root, "hash-right");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    await writeFile(join(left, "x"), "yz", "utf8");
    await writeFile(join(right, "xy"), "z", "utf8");
    expect(await hashCodexPluginRoot(left)).not.toBe(await hashCodexPluginRoot(right));
  });

  it("rejects a symlinked managed root before writing outside userData", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const outside = join(harness.root, "outside-managed-root");
    await mkdir(outside, { recursive: true });
    let linkedCreated = false;
    try {
      await symlink(outside, harness.codexRoot, "dir");
      linkedCreated = true;
    } catch {
      // Windows without symlink privileges cannot exercise this boundary.
    }
    if (!linkedCreated) return;
    await expect(
      harness.installer.install({
        pluginId: "my-tool",
        requestId: "symlinked-root",
        expectedRevision: harness.revision,
        confirmFullTrust: true,
      }),
    ).rejects.toThrow(/managed path/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("accepts case-only differences in Windows managed-root registry paths", async () => {
    if (process.platform !== "win32") return;
    const harness = await createHarness();
    await harness.addPlugin();
    const installed = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "case-install",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    if (installed.status !== "installed") return;
    const record = installed.snapshot.plugins.find((plugin) => plugin.id === "my-tool");
    if (!record?.installedHash || !record.installedRootPath) return;
    const rewritten = await harness.registry.commitInstalled(
      installed.snapshot.revision,
      "my-tool",
      record.installedRootPath.toUpperCase(),
      record.installedHash,
      record.version,
    );
    if (rewritten.status !== "saved") return;

    await expect(
      harness.installer.uninstall({
        pluginId: "my-tool",
        requestId: "case-uninstall",
        expectedRevision: rewritten.snapshot.revision,
        confirmRemoval: true,
      }),
    ).resolves.toMatchObject({ status: "uninstalled" });
  });

  it("rejects plugins whose Marketplace installation policy is NOT_AVAILABLE", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    await writeFile(
      join(harness.homeDir, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify({ name: "personal", plugins: [{ name: "my-tool", source: { source: "local", path: "./plugins/my-tool" }, policy: { installation: "NOT_AVAILABLE" } }] }, null, 2)}\n`,
      "utf8",
    );
    await harness.refreshDiscovery();
    await expect(
      harness.installer.install({
        pluginId: "my-tool",
        requestId: "not-available",
        expectedRevision: harness.revision,
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("not available for installation");
  });

  it("never copies Desktop-owned files into the managed copy", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    await writeFile(join(harness.homeDir, "plugins", "my-tool", ".meta-agent-probe.json"), "{}", "utf8");
    await mkdir(join(harness.homeDir, "plugins", "my-tool", ".versions"), { recursive: true });
    await writeFile(join(harness.homeDir, "plugins", "my-tool", ".versions", "x"), "nope", "utf8");
    const result = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-2",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(result.status).toBe("installed");
    const installed = await harness.record("my-tool");
    if (!installed?.installedHash) return;
    const files = await harness.payloadFiles("my-tool", installed.installedHash);
    expect(files).not.toContain(".meta-agent-probe.json");
    expect(files).not.toContain(".versions/x");
  });

  it("rejects source symlinks that escape the plugin root", async () => {
    const harness = await createHarness();
    const pluginRoot = join(harness.homeDir, "plugins", "my-tool");
    await writeCodexPluginSource(pluginRoot, "0.1.0");
    await writeFile(join(harness.homeDir, "shared.txt"), "linked content\n", "utf8");
    await mkdir(join(pluginRoot, "skills"), { recursive: true });
    let linkedCreated = false;
    try {
      await symlink(join(harness.homeDir, "shared.txt"), join(pluginRoot, "skills", "linked.md"));
      linkedCreated = true;
    } catch {
      // Windows without developer mode may fail to create symlinks; the assertion is skipped then.
    }
    if (!linkedCreated) return;
    await harness.refreshDiscovery();
    await expect(
      harness.installer.install({
        pluginId: "my-tool",
        requestId: "install-3",
        expectedRevision: harness.revision,
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("outside the plugin root");
  });

  it("replays a completed install for the same request id", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const input = {
      pluginId: "my-tool",
      requestId: "install-4",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    };
    const first = await harness.installer.install(input);
    expect(first.status).toBe("installed");
    await harness.mutatePlugin("my-tool", "buffer.js", "export function changed() {}\n");
    const replay = await harness.installer.install(input);
    expect(replay.status).toBe("installed");
    if (replay.status !== "installed") return;
    expect(replay.snapshot.plugins.find((p) => p.id === "my-tool")?.installedHash).toBe(
      first.status === "installed" ? first.snapshot.plugins.find((p) => p.id === "my-tool")?.installedHash : undefined,
    );
  });

  it("returns already-installed for a second install with a fresh request id", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-5",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    const second = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-6",
      expectedRevision: first.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(second.status).toBe("already-installed");
  });

  it("returns conflict when the registry revision moved", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    await harness.registry.reconcile([]); // 触发无变化抑制之外的一次写
    const current = await harness.registry.getSnapshot();
    const result = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-7",
      expectedRevision: `${harness.revision}-stale`,
      confirmFullTrust: true,
    });
    expect(result.status).toBe("conflict");
    expect(result.status === "conflict" && result.current.revision).toBe(current.revision);
  });

  it("rejects installs without explicit full-trust confirmation", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    await expect(
      harness.installer.install({
        pluginId: "my-tool",
        requestId: "install-8",
        expectedRevision: harness.revision,
      }),
    ).rejects.toThrow("requires explicit full-trust confirmation");
  });

  it("throws when the plugin was never discovered", async () => {
    const harness = await createHarness();
    await expect(
      harness.installer.install({
        pluginId: "unknown-tool",
        requestId: "install-9",
        expectedRevision: harness.revision,
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("Codex plugin is not discovered: unknown-tool");
  });

  it("updates by copying new source content and deriving a cachebuster version", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-10",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    const before = first.snapshot.plugins.find((p) => p.id === "my-tool");
    await harness.mutatePlugin("my-tool", "buffer.js", "export function v2() {}\n");
    const updated = await harness.installer.update({
      pluginId: "my-tool",
      requestId: "update-1",
      expectedRevision: first.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    const after = updated.snapshot.plugins.find((p) => p.id === "my-tool");
    expect(after?.version).toBe("0.1.0+codex.20260907120000");
    expect(after?.installedHash).not.toBe(before?.installedHash);
    // Old generations remain usable until startup reconciliation.
    const newVersion = after?.installedHash;
    if (newVersion) {
      const files = await readdir(join(harness.codexRoot, "my-tool", ".versions", newVersion), { recursive: true });
      expect(files).toContain("buffer.js");
    }
    const oldVersion = before?.installedHash;
    if (oldVersion) {
      expect(await readdir(join(harness.codexRoot, "my-tool", ".versions", oldVersion))).toContain("buffer.js");
      await harness.mutatePlugin("my-tool", "buffer.js", "export function ping() {}\n");
      const reverted = await harness.installer.update({
        pluginId: "my-tool",
        requestId: "revert-content",
        expectedRevision: updated.snapshot.revision,
        confirmFullTrust: true,
      });
      expect(reverted.status).toBe("updated");
      expect((await harness.record("my-tool"))?.installedHash).toBe(oldVersion);
    }
  });

  it("returns same-version when the source content did not change", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-11",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    const updated = await harness.installer.update({
      pluginId: "my-tool",
      requestId: "update-2",
      expectedRevision: first.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(updated.status).toBe("same-version");
  });

  it("keeps the source version when the source bumped the manifest version", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-12",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    // 直接改写源：bump manifest 版本且不触发重新发现（reconcile 会因源变化清除安装状态）
    const manifestPath = join(harness.homeDir, "plugins", "my-tool", ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
    manifest.version = "0.2.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await harness.mutatePlugin("my-tool", "buffer.js", "export function v2() {}\n");
    const updated = await harness.installer.update({
      pluginId: "my-tool",
      requestId: "update-3",
      expectedRevision: first.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(updated.status).toBe("updated");
    if (updated.status !== "updated") return;
    expect(updated.snapshot.plugins.find((p) => p.id === "my-tool")?.version).toBe("0.2.0");
  });

  it("returns not-installed for updates of never-installed plugins", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const updated = await harness.installer.update({
      pluginId: "my-tool",
      requestId: "update-4",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(updated.status).toBe("not-installed");
  });

  it("uninstalls immediately from the registry and collects retained payloads on restart", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-13",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    const uninstalled = await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "uninstall-1",
      expectedRevision: first.snapshot.revision,
      confirmRemoval: true,
    });
    expect(uninstalled.status).toBe("uninstalled");
    if (uninstalled.status !== "uninstalled") return;
    const after = uninstalled.snapshot.plugins.find((p) => p.id === "my-tool");
    expect(after?.installedHash).toBeUndefined();
    expect(after?.installedRootPath).toBeUndefined();
    // 发现记录仍然保留（rootPath 是发现时的 realpath 结果，macOS TMPDIR 是 /var → /private/var 链接）
    expect(after?.rootPath).toBe(await realpath(join(harness.homeDir, "plugins", "my-tool")));
    expect(await readdir(join(harness.codexRoot, "my-tool"))).toEqual([".versions"]);
    const reinstalled = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "reinstall-retained",
      expectedRevision: uninstalled.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(reinstalled.status).toBe("installed");
    if (reinstalled.status !== "installed") throw new Error("Reinstall failed");
    await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "remove-again",
      expectedRevision: reinstalled.snapshot.revision,
      confirmRemoval: true,
    });
    await new CodexPluginReconciler(
      harness.registry,
      harness.codexRoot,
      join(harness.userDataDir, "plugins", "locks"),
    ).reconcile();
    await expect(readdir(join(harness.codexRoot, "my-tool"))).rejects.toThrow();
  });

  it("returns not-installed when uninstalling twice", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-14",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") return;
    await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "uninstall-2",
      expectedRevision: first.snapshot.revision,
      confirmRemoval: true,
    });
    const current = await harness.registry.getSnapshot();
    const second = await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "uninstall-3",
      expectedRevision: current.revision,
      confirmRemoval: true,
    });
    expect(second.status).toBe("not-installed");
  });

  it("rejects uninstalls without explicit removal confirmation", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    await expect(
      harness.installer.uninstall({
        pluginId: "my-tool",
        requestId: "uninstall-4",
        expectedRevision: harness.revision,
      }),
    ).rejects.toThrow("requires explicit removal confirmation");
  });

  it("cleans up a landed payload and staging when the registry commit fails", async () => {
    const harness = await createHarness({
      beforeRegistryCommit: async () => {
        throw new Error("commit failed");
      },
    });
    await harness.addPlugin();
    await expect(
      harness.installer.install({
        pluginId: "my-tool",
        requestId: "install-16",
        expectedRevision: harness.revision,
        confirmFullTrust: true,
      }),
    ).rejects.toThrow("commit failed");
    // payload 已落位但注册未提交：本轮创建的根与载荷必须全部清理
    expect(await readdir(join(harness.codexRoot, "my-tool")).catch(() => [])).toEqual([]);
    expect(await readdir(join(harness.codexRoot, ".meta-agent-codex-staging")).catch(() => [])).toEqual([]);
    const record = await harness.record("my-tool");
    expect(record?.installedHash).toBeUndefined();
  });

  it("reinstalls after an uninstall with a fresh request id", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-17",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    if (first.status !== "installed") return;
    const uninstalled = await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "uninstall-17",
      expectedRevision: first.snapshot.revision,
      confirmRemoval: true,
    });
    if (uninstalled.status !== "uninstalled") return;
    const again = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-18",
      expectedRevision: uninstalled.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(again.status).toBe("installed");
    if (again.status !== "installed") return;
    const record = again.snapshot.plugins.find((p) => p.id === "my-tool");
    expect(record?.installedHash).toBeDefined();
    expect(
      await readFile(join(harness.codexRoot, "my-tool", ".versions", record?.installedHash ?? "", "buffer.js"), "utf8"),
    ).toContain("ping");
  });

  it("re-installs instead of short-circuiting when the installed payload went missing", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-19",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    if (first.status !== "installed") return;
    const record = first.snapshot.plugins.find((p) => p.id === "my-tool");
    if (!record?.installedHash) return;
    await rm(join(harness.codexRoot, "my-tool", ".versions", record.installedHash), { recursive: true, force: true });
    const again = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-20",
      expectedRevision: first.snapshot.revision,
      confirmFullTrust: true,
    });
    // payload 缺失时不短路成 already-installed：按正常流程重建副本
    expect(again.status).toBe("installed");
    if (again.status !== "installed") return;
    const after = again.snapshot.plugins.find((p) => p.id === "my-tool");
    expect(after?.installedHash).toBeDefined();
    expect(
      await readFile(join(harness.codexRoot, "my-tool", ".versions", after?.installedHash ?? "", "buffer.js"), "utf8"),
    ).toContain("ping");
  });

  it("returns conflict for update and uninstall when the registry revision moved", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    const first = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-21",
      expectedRevision: harness.revision,
      confirmFullTrust: true,
    });
    if (first.status !== "installed") return;
    // 让 revision 前移：清空发现会重写注册表文件
    await harness.registry.reconcile([]);
    const update = await harness.installer.update({
      pluginId: "my-tool",
      requestId: "update-21",
      expectedRevision: first.snapshot.revision,
      confirmFullTrust: true,
    });
    expect(update.status).toBe("conflict");
    const uninstall = await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "uninstall-21",
      expectedRevision: first.snapshot.revision,
      confirmRemoval: true,
    });
    expect(uninstall.status).toBe("conflict");
  });

  it("cleans up staging and uncommitted payloads when the source disappears before verification", async () => {
    const harness = await createHarness();
    await harness.addPlugin();
    // 源在安装开始前消失 → hashCodexPluginRoot 失败 → staging 与未提交载荷全部清理
    const pluginRoot = join(harness.homeDir, "plugins", "my-tool");
    await rm(pluginRoot, { recursive: true, force: true });
    await expect(
      harness.installer.install({
        pluginId: "my-tool",
        requestId: "install-15",
        expectedRevision: harness.revision,
        confirmFullTrust: true,
      }),
    ).rejects.toThrow();
    expect(await readdir(join(harness.codexRoot, "my-tool")).catch(() => [])).toEqual([]);
    const record = await harness.record("my-tool");
    expect(record?.installedHash).toBeUndefined();
    expect(await readdir(join(harness.codexRoot, ".meta-agent-codex-staging")).catch(() => [])).toEqual([]);
  });
});

async function writeCodexPluginSource(pluginRoot: string, version: string): Promise<void> {
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "demo"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "my-tool",
        version,
        description: "test plugin",
        author: { name: "test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(pluginRoot, "skills", "demo", "SKILL.md"), `---\nname: demo\n---\nDemo skill.\n`, "utf8");
}
