import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexPluginInstaller } from "../src/main/plugins/codex/codex-plugin-installer.ts";
import { CodexPluginReconciler } from "../src/main/plugins/codex/codex-plugin-reconciler.ts";
import { CodexPluginRegistry } from "../src/main/plugins/codex/codex-plugin-registry.ts";
import { discoverCodexPluginSources } from "../src/main/plugins/codex/codex-plugin-sources.ts";

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

describe("codex-plugin-reconciler", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createHarness() {
    const root = join(tmpdir(), `codex-reconciler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    const pluginRoot = join(homeDir, "plugins", "my-tool");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "demo"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      `${JSON.stringify(
        { name: "my-tool", version: "0.1.0", description: "test plugin", author: { name: "test" } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(pluginRoot, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nDemo.\n", "utf8");
    const registry = new CodexPluginRegistry(userDataDir);
    const codexRoot = join(userDataDir, "plugins", "codex-extensions");
    const lockDirectory = join(userDataDir, "plugins", "locks");
    const installer = new CodexPluginInstaller(registry, lockDirectory, codexRoot, { now: () => NOW });
    const reconciler = new CodexPluginReconciler(registry, codexRoot, lockDirectory);
    await registry.reconcile((await discoverCodexPluginSources(homeDir)).plugins);
    return { root, homeDir, userDataDir, codexRoot, registry, installer, reconciler };
  }

  async function installPlugin(harness: Awaited<ReturnType<typeof createHarness>>) {
    const revision = (await harness.registry.getSnapshot()).revision;
    const result = await harness.installer.install({
      pluginId: "my-tool",
      requestId: "install-r",
      expectedRevision: revision,
      confirmFullTrust: true,
    });
    expect(result.status).toBe("installed");
    return result.status === "installed" ? result : undefined;
  }

  it("removes orphan staging directories", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.codexRoot, ".meta-agent-codex-staging", "my-tool-stale"), {
      recursive: true,
    });
    await writeFile(
      join(harness.codexRoot, ".meta-agent-codex-staging", "my-tool-stale", "partial.json"),
      "{}",
      "utf8",
    );
    await harness.reconciler.reconcile();
    const entries = await readdir(join(harness.codexRoot, ".meta-agent-codex-staging")).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("removes a version payload that landed but never committed", async () => {
    const harness = await createHarness();
    // 手工模拟崩溃窗口：payload 已落位但 registry 从未提交（记录无 installedHash）
    const hash = "a".repeat(64);
    await mkdir(join(harness.codexRoot, "my-tool", ".versions", hash), { recursive: true });
    await writeFile(join(harness.codexRoot, "my-tool", ".versions", hash, "orphan.txt"), "x", "utf8");
    await harness.reconciler.reconcile();
    // 根目录已整体拆除
    expect(await readdir(join(harness.codexRoot, "my-tool")).catch(() => [])).toEqual([]);
  });

  it("clears installed state when the installed payload went missing", async () => {
    const harness = await createHarness();
    const installed = await installPlugin(harness);
    if (!installed) return;
    const record = installed.snapshot.plugins.find((p) => p.id === "my-tool");
    if (!record?.installedHash) return;
    await rm(join(harness.codexRoot, "my-tool", ".versions", record.installedHash), { recursive: true, force: true });
    await harness.reconciler.reconcile();
    const after = (await harness.registry.getSnapshot()).plugins.find((p) => p.id === "my-tool");
    expect(after?.installedHash).toBeUndefined();
    expect(after?.installedRootPath).toBeUndefined();
    expect(await readdir(join(harness.codexRoot, "my-tool")).catch(() => [])).toEqual([]);
  });

  it("leaves a healthy installed copy alone", async () => {
    const harness = await createHarness();
    const installed = await installPlugin(harness);
    if (!installed) return;
    await harness.reconciler.reconcile();
    const after = (await harness.registry.getSnapshot()).plugins.find((p) => p.id === "my-tool");
    expect(after?.installedHash).toBe(installed.snapshot.plugins.find((p) => p.id === "my-tool")?.installedHash);
    const payload = join(harness.codexRoot, "my-tool", ".versions", after?.installedHash ?? "");
    expect(await readFile(join(payload, "skills", "demo", "SKILL.md"), "utf8")).toContain("Demo.");
  });

  it("preserves managed roots with unknown content", async () => {
    const harness = await createHarness();
    await mkdir(join(harness.codexRoot, "my-tool", "user-data"), { recursive: true });
    await writeFile(join(harness.codexRoot, "my-tool", "user-data", "notes.txt"), "keep me", "utf8");
    await harness.reconciler.reconcile();
    const entries = await readdir(join(harness.codexRoot, "my-tool"), { recursive: true });
    expect(entries).toContain(join("user-data", "notes.txt"));
  });

  it("keeps an installed copy across discovery passes after a cachebusted update", async () => {
    const harness = await createHarness();
    const installed = await installPlugin(harness);
    if (!installed) return;
    // 内容更新但 manifest 版本不变：安装器应派生 cachebuster 版本
    await writeFile(join(harness.homeDir, "plugins", "my-tool", "buffer.js"), "v2", "utf8");
    const updated = await harness.installer.update({
      pluginId: "my-tool",
      requestId: "update-r",
      expectedRevision: (await harness.registry.getSnapshot()).revision,
      confirmFullTrust: true,
    });
    if (updated.status !== "updated") return;
    const updatedHash = updated.snapshot.plugins.find((p) => p.id === "my-tool")?.installedHash;
    // 重启语义：重新发现 + reconcile 后，cachebuster 版本不得被误判为"源变化"而撤销安装
    await harness.registry.reconcile((await discoverCodexPluginSources(harness.homeDir)).plugins);
    await harness.reconciler.reconcile();
    const after = (await harness.registry.getSnapshot()).plugins.find((p) => p.id === "my-tool");
    expect(after?.installedHash).toBe(updatedHash);
    expect(after?.version).toContain("+codex.");
    const payload = join(harness.codexRoot, "my-tool", ".versions", after?.installedHash ?? "");
    expect(await readFile(join(payload, "buffer.js"), "utf8")).toBe("v2");
  });

  it("removes orphaned version payloads of a committed update", async () => {
    const harness = await createHarness();
    const installed = await installPlugin(harness);
    if (!installed) return;
    // 手工模拟更新崩溃窗口：新 payload 提交后旧 payload 删除失败留下的孤儿版本
    const orphan = "b".repeat(64);
    await mkdir(join(harness.codexRoot, "my-tool", ".versions", orphan), { recursive: true });
    await writeFile(join(harness.codexRoot, "my-tool", ".versions", orphan, "stale.txt"), "x", "utf8");
    await harness.reconciler.reconcile();
    const versions = await readdir(join(harness.codexRoot, "my-tool", ".versions"));
    const active = installed.snapshot.plugins.find((p) => p.id === "my-tool")?.installedHash ?? "";
    expect(versions).toEqual([active]);
  });

  it("completes an interrupted uninstall by removing the managed copy", async () => {
    const harness = await createHarness();
    const installed = await installPlugin(harness);
    if (!installed) return;
    // uninstall 已提交但副本删除失败（模拟崩溃）：重新创建副本目录但保留 registry 已清状态
    await harness.installer.uninstall({
      pluginId: "my-tool",
      requestId: "uninstall-r",
      expectedRevision: (await harness.registry.getSnapshot()).revision,
      confirmRemoval: true,
    });
    // 手工放回纯 .versions 结构模拟残留
    const hash = installed.snapshot.plugins.find((p) => p.id === "my-tool")?.installedHash ?? "";
    await mkdir(join(harness.codexRoot, "my-tool", ".versions", hash), { recursive: true });
    await harness.reconciler.reconcile();
    expect(await readdir(join(harness.codexRoot, "my-tool")).catch(() => [])).toEqual([]);
  });
});
