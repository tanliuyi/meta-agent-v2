import { cp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CodexPluginSourceIssue,
  discoverCodexPluginSources,
  discoverCodexPluginSourcesFromMarketplace,
} from "../src/main/plugins/codex/codex-plugin-sources.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const DART_FLUTTER_FIXTURE = join(import.meta.dirname, "fixtures", "codex", "plugins", "dart-flutter");

interface HomeLayout {
  homeDir: string;
  marketplacePath: string;
}

async function createHome(entries: unknown[]): Promise<HomeLayout> {
  const homeDir = join(tmpdir(), `codex-sources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directories.push(homeDir);
  const marketplacePath = join(homeDir, ".agents", "plugins", "marketplace.json");
  await mkdir(join(homeDir, ".agents", "plugins"), { recursive: true });
  await writeFile(
    marketplacePath,
    `${JSON.stringify({ name: "personal", interface: { displayName: "Personal" }, plugins: entries }, null, 2)}\n`,
    "utf8",
  );
  return { homeDir, marketplacePath };
}

async function installDartFlutterPlugin(homeDir: string): Promise<string> {
  const rootPath = join(homeDir, "plugins", "dart-flutter");
  await mkdir(join(homeDir, "plugins"), { recursive: true });
  await cp(DART_FLUTTER_FIXTURE, rootPath, { recursive: true });
  return rootPath;
}

function entry(name: string, path?: string, source: string = "local", extra: Record<string, unknown> = {}) {
  const plugin: Record<string, unknown> = { name, source: { source, ...(path === undefined ? {} : { path }) } };
  return { ...plugin, ...extra };
}

/** Probes once whether symlinks can be created on this platform. */
const symlinksSupported = await (async () => {
  const dir = join(tmpdir(), `codex-sources-symlink-probe-${Math.random().toString(36).slice(2)}`);
  try {
    await mkdir(dir, { recursive: true });
    await symlink(dir, join(dir, "self"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

describe("discoverCodexPluginSources", () => {
  it("discovers a validated local plugin root declared by the personal Marketplace", async () => {
    const { homeDir, marketplacePath } = await createHome([entry("dart-flutter", "./plugins/dart-flutter")]);
    await installDartFlutterPlugin(homeDir);

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin?.name).toBe("dart-flutter");
    expect(plugin?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plugin?.displayName).toBe("Dart and Flutter");
    expect(plugin?.rootPath).toBe(await realpath(join(homeDir, "plugins", "dart-flutter")));
    expect(plugin?.sourcePath).toBe("plugins/dart-flutter");
    expect(plugin?.marketplacePath).toBe(marketplacePath);
    expect(result.issues).toEqual([]);
  });

  it("prefers the entry interface display name over the manifest display name", async () => {
    const { homeDir } = await createHome([
      { ...entry("dart-flutter", "./plugins/dart-flutter"), interface: { displayName: "Dart Flutter Tools" } },
    ]);
    await installDartFlutterPlugin(homeDir);

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins[0]?.displayName).toBe("Dart Flutter Tools");
  });

  it("skips remote url entries without local roots", async () => {
    const { homeDir } = await createHome([
      entry("dart-flutter", "./plugins/dart-flutter"),
      { name: "remote-tool", source: { source: "url", url: "https://github.com/example/remote-tool.git" } },
    ]);
    await installDartFlutterPlugin(homeDir);

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["dart-flutter"]);
    expect(result.issues).toEqual([]);
  });

  it("reports unsafe, missing, and legacy-layout local roots with stable diagnostics", async () => {
    // 绝对路径与 .. 遍历在 Marketplace 解析层被拒（marketplace.invalid）且条目不携带
    // source.path；发现层因此同时给出 source.unsafe。
    const legacyRoot = join(tmpdir(), `codex-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(legacyRoot);
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, "market-manifest.json"), "{}", "utf8");
    const { homeDir } = await createHome([
      entry("escape", "../../escape"),
      entry("absolute", "C:\\absolute\\plugin"),
      entry("missing-root", "./plugins/missing-root"),
      entry("legacy", "./plugins/legacy"),
    ]);
    await cp(legacyRoot, join(homeDir, "plugins", "legacy"), { recursive: true });

    const result = await discoverCodexPluginSources(homeDir);

    const byCode = new Map<string, CodexPluginSourceIssue[]>();
    for (const issue of result.issues) {
      byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue]);
    }
    expect([...byCode.keys()].sort()).toEqual([
      "marketplace.invalid",
      "plugin.legacy-layout",
      "source.missing",
      "source.unsafe",
    ]);
    expect(byCode.get("marketplace.invalid")?.map((issue) => issue.pluginName)).toEqual([undefined, undefined]);
    expect(byCode.get("marketplace.invalid")?.[0]?.message).toContain("must be a non-empty relative path");
    expect(
      byCode
        .get("source.unsafe")
        ?.map((issue) => issue.pluginName)
        .sort(),
    ).toEqual(["absolute", "escape"]);
    expect(byCode.get("source.unsafe")?.[0]?.message).toContain("absolute or escapes");
    expect(byCode.get("source.missing")?.map((issue) => issue.pluginName)).toEqual(["missing-root"]);
    expect(byCode.get("source.missing")?.[0]?.message).toContain("does not exist");
    expect(byCode.get("plugin.legacy-layout")?.[0]?.message).toContain("market-manifest.json");
    expect(result.plugins).toEqual([]);
  });

  it("reports root paths that are files or symlinks as missing directories", async () => {
    const { homeDir } = await createHome([
      entry("file-root", "./plugins/file-root"),
      entry("symlink-root", "./plugins/symlink-root"),
    ]);
    await mkdir(join(homeDir, "plugins"), { recursive: true });
    await writeFile(join(homeDir, "plugins", "file-root"), "not a directory", "utf8");
    const realDir = join(homeDir, "plugins", "real-plugin");
    await mkdir(realDir, { recursive: true });
    let symlinkCreated = true;
    try {
      await symlink(realDir, join(homeDir, "plugins", "symlink-root"), "dir");
    } catch {
      symlinkCreated = false;
    }

    const result = await discoverCodexPluginSources(homeDir);

    // symlink-root 的发现结果平台相关：目录符号链接创建失败时该条目只报告 source.missing。
    const expectedNames = symlinkCreated ? ["file-root", "symlink-root"] : ["file-root"];
    expect(
      result.issues
        .filter((issue) => issue.code === "source.missing")
        .map((issue) => issue.pluginName)
        .sort(),
    ).toEqual(expectedNames.sort());
    expect(result.plugins).toEqual([]);
  });

  it("reports manifest validation failures as plugin.invalid", async () => {
    const { homeDir } = await createHome([
      entry("no-manifest", "./plugins/no-manifest"),
      entry("broken-manifest", "./plugins/broken-manifest"),
    ]);
    await mkdir(join(homeDir, "plugins"), { recursive: true });
    await mkdir(join(homeDir, "plugins", "no-manifest"), { recursive: true });
    await mkdir(join(homeDir, "plugins", "broken-manifest", ".codex-plugin"), { recursive: true });
    await writeFile(join(homeDir, "plugins", "broken-manifest", ".codex-plugin", "plugin.json"), "not json", "utf8");

    const result = await discoverCodexPluginSources(homeDir);

    const invalid = result.issues.filter((issue) => issue.code === "plugin.invalid");
    expect(invalid.map((issue) => issue.pluginName).sort()).toEqual(["broken-manifest", "no-manifest"]);
    expect(invalid[0]?.message).toContain("Plugin manifest is invalid");
    expect(result.plugins).toEqual([]);
  });

  it("rejects entries whose manifest name does not match the Marketplace entry name", async () => {
    const { homeDir } = await createHome([entry("renamed", "./plugins/dart-flutter")]);
    await installDartFlutterPlugin(homeDir);

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "plugin.invalid",
        pluginName: "renamed",
        message: expect.stringContaining("does not match the Marketplace entry name"),
      }),
    ]);
  });

  it("returns an empty result when the personal Marketplace file is missing", async () => {
    const homeDir = join(tmpdir(), `codex-sources-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(homeDir);
    await mkdir(homeDir, { recursive: true });

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("reports an invalid Marketplace file with its path prefix", async () => {
    const { homeDir, marketplacePath } = await createHome([]);
    await writeFile(marketplacePath, "{ invalid", "utf8");

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "marketplace.invalid",
        marketplacePath,
        message: expect.stringContaining("must be valid JSON"),
      }),
    ]);
  });

  it.skipIf(!symlinksSupported)("treats a symlinked Marketplace file as unreadable", async () => {
    const { homeDir, marketplacePath } = await createHome([]);
    await rm(marketplacePath);
    await writeFile(join(homeDir, ".agents", "plugins", "real.json"), "{}", "utf8");
    await symlink(join(homeDir, ".agents", "plugins", "real.json"), marketplacePath);

    const result = await discoverCodexPluginSources(homeDir);

    expect(result.plugins).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "marketplace.read-failed" })]);
  });

  it("supports explicit marketplace file discovery with a repo-style root", async () => {
    const repoRoot = join(tmpdir(), `codex-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(repoRoot);
    const marketplacePath = join(repoRoot, ".agents", "plugins", "marketplace.json");
    await mkdir(join(repoRoot, ".agents", "plugins"), { recursive: true });
    await writeFile(
      marketplacePath,
      `${JSON.stringify({ name: "repo", plugins: [entry("dart-flutter", "./plugins/dart-flutter")] }, null, 2)}\n`,
      "utf8",
    );
    const rootPath = join(repoRoot, "plugins", "dart-flutter");
    await mkdir(join(repoRoot, "plugins"), { recursive: true });
    await cp(DART_FLUTTER_FIXTURE, rootPath, { recursive: true });

    const result = await discoverCodexPluginSourcesFromMarketplace(marketplacePath);

    expect(result.plugins[0]?.rootPath).toBe(await realpath(rootPath));
    expect(result.plugins[0]?.sourcePath).toBe("plugins/dart-flutter");
    expect(result.issues).toEqual([]);
  });
});
