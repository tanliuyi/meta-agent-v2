import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MISSING_SETTINGS_CONFIG_REVISION,
  SettingsConfigService,
} from "../src/main/settings/settings-config-service.ts";
import {
  MESSAGE_WIDTH_DEFAULT,
  MESSAGE_WIDTH_MAX,
  MESSAGE_WIDTH_MIN,
} from "../src/shared/settings-config-contracts.ts";

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

  test("缺失配置不会创建文件，且默认显示 thinking 并自动展开 running", async () => {
    const snapshot = await service.getConfig();

    expect(snapshot).toEqual({
      path: configPath,
      exists: false,
      revision: MISSING_SETTINGS_CONFIG_REVISION,
      settings: {
        showThinking: true,
        autoExpandRunning: true,
        showAvatars: true,
        messageWidth: MESSAGE_WIDTH_DEFAULT,
        userName: "用户",
        userAvatarPath: null,
        terminalShellPath: null,
      },
    });
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("首次保存创建 settings.json", async () => {
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: {
        showThinking: false,
        autoExpandRunning: false,
        showAvatars: false,
        messageWidth: 960,
        userName: "Tan",
        userAvatarPath: "/Users/tan/avatar.png",
        terminalShellPath: null,
      },
    });

    expect(result).toMatchObject({
      status: "saved",
      snapshot: {
        exists: true,
        settings: {
          showThinking: false,
          autoExpandRunning: false,
          showAvatars: false,
          messageWidth: 960,
          userName: "Tan",
          userAvatarPath: "/Users/tan/avatar.png",
          terminalShellPath: null,
        },
      },
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      showThinking: false,
      autoExpandRunning: false,
      showAvatars: false,
      messageWidth: 960,
      userName: "Tan",
      userAvatarPath: "/Users/tan/avatar.png",
      terminalShellPath: null,
    });
  });

  test("原子保存 Desktop 设置并保留未知键", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, { encoding: "utf8", mode: 0o644 });
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: {
        showThinking: true,
        autoExpandRunning: false,
        showAvatars: true,
        messageWidth: 960,
        userName: "用户",
        userAvatarPath: null,
        terminalShellPath: null,
      },
    });

    expect(result.status).toBe("saved");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      showThinking: true,
      futureSetting: { enabled: true },
      autoExpandRunning: false,
      showAvatars: true,
      messageWidth: 960,
      userName: "用户",
      userAvatarPath: null,
      terminalShellPath: null,
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
      settings: {
        showThinking: false,
        autoExpandRunning: false,
        showAvatars: true,
        messageWidth: 810,
        userName: "用户",
        userAvatarPath: null,
        terminalShellPath: null,
      },
    });

    expect(result).toMatchObject({
      status: "conflict",
      current: {
        settings: {
          showThinking: true,
          autoExpandRunning: true,
          showAvatars: true,
          messageWidth: MESSAGE_WIDTH_DEFAULT,
          userName: "用户",
          userAvatarPath: null,
          terminalShellPath: null,
        },
      },
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ version: 1, showThinking: true });
  });

  test("拒绝无效输入和无法解析的源文件", async () => {
    await expect(
      service.saveConfig({
        expectedRevision: MISSING_SETTINGS_CONFIG_REVISION,
        settings: {
          showThinking: "false",
          autoExpandRunning: true,
          showAvatars: true,
          messageWidth: 810,
          userName: "用户",
          userAvatarPath: null,
          terminalShellPath: null,
        },
      } as never),
    ).rejects.toThrow("Invalid settings save input");
    await expect(
      service.saveConfig({
        expectedRevision: MISSING_SETTINGS_CONFIG_REVISION,
        settings: {
          showThinking: false,
          autoExpandRunning: true,
          showAvatars: true,
          messageWidth: "960",
          userName: "用户",
          userAvatarPath: null,
          terminalShellPath: null,
        },
      } as never),
    ).rejects.toThrow("Invalid settings save input");
    await expect(
      service.saveConfig({
        expectedRevision: MISSING_SETTINGS_CONFIG_REVISION,
        settings: {
          showThinking: false,
          autoExpandRunning: true,
          showAvatars: "yes",
          messageWidth: 810,
          userName: "用户",
          userAvatarPath: null,
          terminalShellPath: null,
        },
      } as never),
    ).rejects.toThrow("Invalid settings save input");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(directory, { recursive: true });
    await writeFile(configPath, "{ invalid", "utf8");
    await expect(service.getConfig()).rejects.toThrow("settings.json JSON syntax invalid");
  });

  test("读取时夹取消息宽度、保留满屏并拒绝非数字值", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ version: 1, messageWidth: 99999 }, null, 2)}\n`, "utf8");
    expect((await service.getConfig()).settings.messageWidth).toBe(MESSAGE_WIDTH_MAX);

    await writeFile(configPath, `${JSON.stringify({ version: 1, messageWidth: 100 }, null, 2)}\n`, "utf8");
    expect((await service.getConfig()).settings.messageWidth).toBe(MESSAGE_WIDTH_MIN);

    await writeFile(configPath, `${JSON.stringify({ version: 1, messageWidth: null }, null, 2)}\n`, "utf8");
    expect((await service.getConfig()).settings.messageWidth).toBeNull();

    await writeFile(configPath, `${JSON.stringify({ version: 1, messageWidth: "wide" }, null, 2)}\n`, "utf8");
    await expect(service.getConfig()).rejects.toThrow("settings.json messageWidth must be a finite number or null");
  });

  test("保存前归一化消息宽度", async () => {
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: {
        ...snapshot.settings,
        messageWidth: 555.5,
      },
    });

    expect(result).toMatchObject({ status: "saved", snapshot: { settings: { messageWidth: 560 } } });
    expect(JSON.parse(await readFile(configPath, "utf8")).messageWidth).toBe(560);
  });
  test("保存满屏宽度", async () => {
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: {
        showThinking: true,
        autoExpandRunning: true,
        showAvatars: true,
        messageWidth: null,
        userName: "用户",
        userAvatarPath: null,
        terminalShellPath: null,
      },
    });

    expect(result).toMatchObject({ status: "saved", snapshot: { settings: { messageWidth: null } } });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      showThinking: true,
      autoExpandRunning: true,
      showAvatars: true,
      messageWidth: null,
      userName: "用户",
      userAvatarPath: null,
      terminalShellPath: null,
    });
  });

  test("保存用户名与外部头像路径，不把图片内容写入配置", async () => {
    const snapshot = await service.getConfig();
    const avatarPath = process.platform === "win32" ? "C:\\Users\\tan\\avatar.webp" : "/Users/tan/avatar.webp";

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, userName: "Tan", userAvatarPath: avatarPath },
    });

    expect(result).toMatchObject({
      status: "saved",
      snapshot: { settings: { userName: "Tan", userAvatarPath: avatarPath } },
    });
    const source = await readFile(configPath, "utf8");
    expect(source).toContain(avatarPath.replaceAll("\\", "\\\\"));
    expect(source).not.toContain("data:image/");
  });

  test("拒绝无效用户名及非外部图片路径", async () => {
    const snapshot = await service.getConfig();
    await expect(
      service.saveConfig({
        expectedRevision: snapshot.revision,
        settings: { ...snapshot.settings, userName: " ", userAvatarPath: null },
      }),
    ).rejects.toThrow("Invalid settings save input");
    await expect(
      service.saveConfig({
        expectedRevision: snapshot.revision,
        settings: { ...snapshot.settings, userName: "用户", userAvatarPath: "avatar.png" },
      }),
    ).rejects.toThrow("Invalid settings save input");
    await expect(
      service.saveConfig({
        expectedRevision: snapshot.revision,
        settings: { ...snapshot.settings, userName: "用户", userAvatarPath: "/tmp/avatar.svg" },
      }),
    ).rejects.toThrow("Invalid settings save input");
  });

  test("保存终端 Shell 路径并拒绝相对路径与空白", async () => {
    const snapshot = await service.getConfig();
    const shellPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/opt/homebrew/bin/zsh";

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, terminalShellPath: shellPath },
    });

    expect(result).toMatchObject({
      status: "saved",
      snapshot: { settings: { terminalShellPath: shellPath } },
    });
    expect(JSON.parse(await readFile(configPath, "utf8")).terminalShellPath).toBe(shellPath);

    const saved = result.status === "saved" ? result.snapshot : snapshot;
    await expect(
      service.saveConfig({
        expectedRevision: saved.revision,
        settings: { ...saved.settings, terminalShellPath: "bin/zsh" },
      }),
    ).rejects.toThrow("Invalid settings save input");
    await expect(
      service.saveConfig({
        expectedRevision: saved.revision,
        settings: { ...saved.settings, terminalShellPath: " " },
      }),
    ).rejects.toThrow("Invalid settings save input");
  });

  test("终端 Shell 路径支持 ~ 前缀", async () => {
    const snapshot = await service.getConfig();

    const result = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, terminalShellPath: "~/bin/zsh" },
    });

    expect(result).toMatchObject({
      status: "saved",
      snapshot: { settings: { terminalShellPath: "~/bin/zsh" } },
    });
  });

  test("保存成功后回调携带最新快照", async () => {
    const onSaved = vi.fn();
    const callbackService = new SettingsConfigService(directory, { onSaved });
    const snapshot = await callbackService.getConfig();

    const result = await callbackService.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, terminalShellPath: "/bin/zsh" },
    });

    expect(result.status).toBe("saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ terminalShellPath: "/bin/zsh" }),
      }),
    );
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
