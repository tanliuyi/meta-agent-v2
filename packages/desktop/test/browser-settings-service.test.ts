import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BrowserSettingsService,
  MISSING_BROWSER_SETTINGS_REVISION,
} from "../src/main/browser/browser-settings-service.ts";
import { defaultBrowserSettings } from "../src/shared/browser-settings-contracts.ts";

const directories: string[] = [];

describe("BrowserSettingsService", () => {
  let userDataDir: string;
  let configPath: string;
  let service: BrowserSettingsService;

  beforeEach(() => {
    userDataDir = join(tmpdir(), `desktop-browser-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(userDataDir);
    configPath = join(userDataDir, "browser-settings.json");
    service = new BrowserSettingsService(userDataDir);
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  test("缺失配置返回默认值且不创建配置文件", async () => {
    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      path: configPath,
      exists: false,
      revision: MISSING_BROWSER_SETTINGS_REVISION,
      settings: defaultBrowserSettings(),
    });
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("保存配置并返回更新后的快照", async () => {
    const snapshot = await service.getSnapshot();
    const saved = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, restoreTabsOnLaunch: false, blockSites: ["example.com"] },
    });

    expect(saved.status).toBe("saved");
    expect(saved.status === "saved" ? saved.snapshot.settings : null).toMatchObject({
      restoreTabsOnLaunch: false,
      blockSites: ["example.com"],
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      restoreTabsOnLaunch: false,
      blockSites: ["example.com"],
    });
  });

  test("保存站点审批和媒体权限设置并规范化网站", async () => {
    const snapshot = await service.getSnapshot();
    const saved = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: {
        ...snapshot.settings,
        siteApproval: "always-allow",
        historyAccess: "always-allow",
        mediaDefault: "deny",
        mediaPermissions: [{ site: "https://Example.com/path", camera: "allow", microphone: "deny" }],
      },
    });

    expect(saved.status).toBe("saved");
    expect(saved.status === "saved" ? saved.snapshot.settings : null).toMatchObject({
      siteApproval: "always-allow",
      historyAccess: "always-allow",
      mediaPermissions: [{ site: "example.com", camera: "allow", microphone: "deny" }],
    });
  });

  test("拒绝缺少新权限字段的恶意保存输入", async () => {
    const snapshot = await service.getSnapshot();
    await expect(
      service.saveConfig({
        expectedRevision: snapshot.revision,
        settings: { allowSites: [], blockSites: [] } as never,
      }),
    ).rejects.toThrow("Invalid browser settings save input");
  });

  test("保存配置时保留高级未知字段并检测外部冲突", async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ restoreTabsOnLaunch: false, futureSetting: { enabled: true } }, null, 2)}\n`,
      "utf8",
    );
    const snapshot = await service.getSnapshot();
    const saved = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, maxSnapshotNodes: 500 },
    });

    expect(saved.status).toBe("saved");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      futureSetting: { enabled: true },
      restoreTabsOnLaunch: false,
      maxSnapshotNodes: 500,
    });

    await writeFile(configPath, `${JSON.stringify({ restoreTabsOnLaunch: true }, null, 2)}\n`, "utf8");
    const conflict = await service.saveConfig({
      expectedRevision: saved.status === "saved" ? saved.snapshot.revision : "unreachable",
      settings: snapshot.settings,
    });
    expect(conflict).toMatchObject({ status: "conflict", current: { settings: { restoreTabsOnLaunch: true } } });
  });

  test("非法字段值回退默认值", async () => {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ maxSnapshotNodes: 5, cdpTimeoutMs: 1, allowSites: "not-array" }, null, 2)}\n`,
      "utf8",
    );

    const snapshot = await service.getSnapshot();

    expect(snapshot.settings).toMatchObject({
      maxSnapshotNodes: 200,
      cdpTimeoutMs: 10_000,
      allowSites: [],
    });
  });

  test("拒绝无效保存输入", async () => {
    const snapshot = await service.getSnapshot();
    await expect(
      service.saveConfig({
        expectedRevision: snapshot.revision,
        settings: { ...snapshot.settings, maxSnapshotNodes: 5 },
      }),
    ).rejects.toThrow("Invalid browser settings save input");
    await expect(
      service.saveConfig({
        expectedRevision: "bad",
        settings: { ...snapshot.settings, allowSites: [""] },
      }),
    ).rejects.toThrow("Invalid browser settings save input");
  });

  test("拒绝通过符号链接读取", async () => {
    const realDir = join(tmpdir(), `desktop-browser-settings-real-${Date.now()}`);
    directories.push(realDir);
    const realPath = join(realDir, "browser-settings.json");
    await mkdir(realDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await writeFile(realPath, `${JSON.stringify({ restoreTabsOnLaunch: true }, null, 2)}\n`, "utf8");
    try {
      await symlink(realPath, configPath);
    } catch (error) {
      if (process.platform === "win32" && isNodeError(error, "EPERM")) return;
      throw error;
    }

    await expect(service.getSnapshot()).rejects.toThrow("Refusing to read symlink");
  });
});

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
