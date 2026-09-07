import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexPluginRegistry,
  MISSING_CODEX_REGISTRY_REVISION,
} from "../src/main/plugins/codex/codex-plugin-registry.ts";
import type { CodexPluginSourceRecord } from "../src/main/plugins/codex/codex-plugin-sources.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Harness {
  root: string;
  registry: CodexPluginRegistry;
}

async function createHarness(): Promise<Harness> {
  const root = join(tmpdir(), `codex-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directories.push(root);
  const registry = new CodexPluginRegistry(root, { createId: () => "test" });
  return { root, registry };
}

function sourceRecord(overrides: Partial<CodexPluginSourceRecord> = {}): CodexPluginSourceRecord {
  return {
    name: "dart-flutter",
    version: "1.0.0",
    displayName: "Dart Flutter",
    rootPath: "C:\\home\\plugins\\dart-flutter",
    marketplacePath: "C:\\home\\.agents\\plugins\\marketplace.json",
    sourcePath: "plugins/dart-flutter",
    ...overrides,
  };
}

/** Probes once whether symlinks can be created on this platform. */
const symlinksSupported = await (async () => {
  const dir = join(tmpdir(), `codex-registry-symlink-probe-${Math.random().toString(36).slice(2)}`);
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

describe("CodexPluginRegistry", () => {
  it("starts empty with the missing revision marker", async () => {
    const { registry } = await createHarness();
    const snapshot = await registry.getSnapshot();

    expect(snapshot.revision).toBe(MISSING_CODEX_REGISTRY_REVISION);
    expect(snapshot.plugins).toEqual([]);
  });

  it("records discovered plugins with enabled defaults and a new revision", async () => {
    const { registry } = await createHarness();
    const initial = await registry.getSnapshot();

    const snapshot = await registry.reconcile([sourceRecord()]);

    expect(snapshot.revision).not.toBe(initial.revision);
    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins[0]).toEqual({
      id: "dart-flutter",
      displayName: "Dart Flutter",
      version: "1.0.0",
      rootPath: "C:\\home\\plugins\\dart-flutter",
      marketplacePath: "C:\\home\\.agents\\plugins\\marketplace.json",
      sourcePath: "plugins/dart-flutter",
      enabled: true,
      discoveredAt: expect.any(Number),
    });
  });

  it("keeps the revision when the discovery result is unchanged", async () => {
    const { registry } = await createHarness();
    const first = await registry.reconcile([sourceRecord()]);

    const second = await registry.reconcile([sourceRecord()]);

    expect(second.revision).toBe(first.revision);
  });

  it("preserves the enabled state across discovery passes when the source is unchanged", async () => {
    const { root, registry } = await createHarness();
    await registry.reconcile([sourceRecord()]);
    const registryPath = join(root, "plugins", "codex-plugins.json");
    const data = JSON.parse(await readFile(registryPath, "utf8")) as {
      plugins: Array<{ id: string; enabled: boolean }>;
    };
    const record = data.plugins.find((plugin) => plugin.id === "dart-flutter");
    if (!record) throw new Error("registry record missing");
    record.enabled = false;
    await writeFile(registryPath, `${JSON.stringify({ version: 1, plugins: data.plugins }, null, 2)}\n`, "utf8");

    const snapshot = await registry.reconcile([sourceRecord()]);

    expect(snapshot.plugins[0]?.enabled).toBe(false);
  });

  it("resets enabled to true when the source state changed", async () => {
    const { root, registry } = await createHarness();
    await registry.reconcile([sourceRecord()]);
    const registryPath = join(root, "plugins", "codex-plugins.json");
    const data = JSON.parse(await readFile(registryPath, "utf8")) as {
      plugins: Array<{ id: string; enabled: boolean }>;
    };
    const record = data.plugins.find((plugin) => plugin.id === "dart-flutter");
    if (!record) throw new Error("registry record missing");
    record.enabled = false;
    await writeFile(registryPath, `${JSON.stringify({ version: 1, plugins: data.plugins }, null, 2)}\n`, "utf8");

    const snapshot = await registry.reconcile([
      sourceRecord({ version: "1.1.0", rootPath: "C:\\home\\plugins\\dart-flutter-next" }),
    ]);

    expect(snapshot.plugins[0]?.enabled).toBe(true);
    expect(snapshot.plugins[0]?.version).toBe("1.1.0");
    expect(snapshot.plugins[0]?.rootPath).toBe("C:\\home\\plugins\\dart-flutter-next");
  });

  it("removes records whose discovery entry disappeared", async () => {
    const { registry } = await createHarness();
    await registry.reconcile([sourceRecord(), sourceRecord({ name: "alpha", rootPath: "C:\\home\\plugins\\alpha" })]);

    const snapshot = await registry.reconcile([sourceRecord()]);

    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["dart-flutter"]);
  });

  it("persists records for a fresh registry instance", async () => {
    const { root, registry } = await createHarness();
    await registry.reconcile([sourceRecord()]);

    const fresh = new CodexPluginRegistry(root, { createId: () => "test" });
    const snapshot = await fresh.getSnapshot();

    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins[0]?.id).toBe("dart-flutter");
  });

  it("rejects a corrupt registry file with a stable error", async () => {
    const { root, registry } = await createHarness();
    await mkdir(join(root, "plugins"), { recursive: true });
    await writeFile(join(root, "plugins", "codex-plugins.json"), "{ corrupt", "utf8");

    await expect(registry.getSnapshot()).rejects.toThrow("codex-plugins.json JSON syntax invalid");
  });

  it.skipIf(!symlinksSupported)("refuses to read a symlinked registry file", async () => {
    const { root, registry } = await createHarness();
    await mkdir(join(root, "plugins"), { recursive: true });
    const target = join(root, "outside.json");
    await writeFile(target, "{}", "utf8");
    await symlink(target, join(root, "plugins", "codex-plugins.json"));

    await expect(registry.getSnapshot()).rejects.toThrow("Refusing to read symlink");
  });

  it("creates the registry file with restricted permissions", async () => {
    const { root, registry } = await createHarness();
    await registry.reconcile([sourceRecord()]);
    const info = await stat(join(root, "plugins", "codex-plugins.json"));

    expect(info.isFile()).toBe(true);
    expect(dirname(registry.path)).toBe(join(root, "plugins"));
    if (process.platform !== "win32") {
      expect(info.mode & 0o600).toBe(0o600);
    }
  });
});
