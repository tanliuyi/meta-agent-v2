import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MISSING_SETTINGS_CONFIG_REVISION,
  SettingsConfigService,
} from "../src/main/settings/settings-config-service.ts";

const SOURCE = `${JSON.stringify({ version: 1, showThinking: false, futureSetting: { enabled: true } }, null, 2)}\n`;

describe("SettingsConfigService", () => {
  let directory: string;
  let configPath: string;
  let service: SettingsConfigService;

  beforeEach(() => {
    directory = join(tmpdir(), `desktop-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    configPath = join(directory, "settings.json");
    service = new SettingsConfigService(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("缺失配置不会创建文件，且默认显示 thinking", async () => {
    const snapshot = await service.getConfig();

    expect(snapshot).toEqual({
      path: configPath,
      exists: false,
      revision: MISSING_SETTINGS_CONFIG_REVISION,
      settings: { showThinking: true },
    });
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("首次保存创建 settings.json", async () => {
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { showThinking: false },
    });

    expect(result).toMatchObject({ status: "saved", snapshot: { exists: true, settings: { showThinking: false } } });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ version: 1, showThinking: false });
  });

  test("原子保存 Desktop 设置并保留未知键", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, { encoding: "utf8", mode: 0o644 });
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { showThinking: true },
    });

    expect(result.status).toBe("saved");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      showThinking: true,
      futureSetting: { enabled: true },
    });
    if (process.platform !== "win32") {
      expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("并发或外部修改返回冲突且不覆盖磁盘内容", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    await writeFile(configPath, `${JSON.stringify({ version: 1, showThinking: true }, null, 2)}\n`, "utf8");

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { showThinking: false },
    });

    expect(result).toMatchObject({ status: "conflict", current: { settings: { showThinking: true } } });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ version: 1, showThinking: true });
  });

  test("拒绝无效输入和无法解析的源文件", async () => {
    await expect(
      service.saveConfig({
        expectedRevision: MISSING_SETTINGS_CONFIG_REVISION,
        settings: { showThinking: "false" },
      } as never),
    ).rejects.toThrow("Invalid settings save input");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(directory, { recursive: true });
    await writeFile(configPath, "{ invalid", "utf8");
    await expect(service.getConfig()).rejects.toThrow("settings.json JSON syntax invalid");
  });

  test("拒绝符号链接和非普通文件", async () => {
    const targetDirectory = `${directory}-target`;
    await mkdir(directory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "target.json"), SOURCE, "utf8");
    let symlinkCreated = false;
    try {
      await symlink(join(targetDirectory, "target.json"), configPath);
      symlinkCreated = true;
    } catch (error) {
      if (!(process.platform === "win32" && isNodeError(error, "EPERM"))) throw error;
    }
    if (symlinkCreated) {
      await expect(service.getConfig()).rejects.toThrow("symlink");
      await rm(configPath);
    }
    await mkdir(configPath);
    await expect(service.getConfig()).rejects.toThrow("regular file");
    await rm(targetDirectory, { recursive: true, force: true });
  });
});

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
