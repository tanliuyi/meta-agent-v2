import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PreferencesConfigService } from "../src/main/preferences/preferences-config-service.ts";

describe("PreferencesConfigService", () => {
  let directory: string;
  let configPath: string;
  let service: PreferencesConfigService;

  beforeEach(() => {
    directory = join(tmpdir(), `desktop-preferences-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    configPath = join(directory, "preferences.json");
    service = new PreferencesConfigService(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("缺失配置不会创建文件，返回空 values", async () => {
    const snapshot = await service.getSnapshot();

    expect(snapshot).toEqual({ path: configPath, exists: false, values: {} });
    expect(service.getInitial()).toEqual({ path: configPath, exists: false, values: {} });
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("首次保存创建 preferences.json，getInitial 同步读到相同内容", async () => {
    const result = await service.save({ values: { "pi-desktop:theme": "dark", "pi-desktop:sidebar-width": "320" } });

    expect(result).toEqual({ status: "saved" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      values: { "pi-desktop:theme": "dark", "pi-desktop:sidebar-width": "320" },
    });
    expect(service.getInitial()).toEqual({
      path: configPath,
      exists: true,
      values: { "pi-desktop:theme": "dark", "pi-desktop:sidebar-width": "320" },
    });
    if (process.platform !== "win32") {
      expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("合并保存：已有键被覆盖、未知键与未提及键保留", async () => {
    await service.save({ values: { theme: "light", kept: "yes" } });
    const result = await service.save({ values: { theme: "dark", added: "new" } });

    expect(result).toEqual({ status: "saved" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 1,
      values: { theme: "dark", kept: "yes", added: "new" },
    });
  });

  test("损坏文件回退为空而不是抛错，且下一次保存会修复", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, "{ invalid", "utf8");

    expect(service.getInitial()).toEqual({ path: configPath, exists: true, values: {} });
    expect(await service.getSnapshot()).toEqual({ path: configPath, exists: true, values: {} });

    const result = await service.save({ values: { theme: "dark" } });
    expect(result).toEqual({ status: "saved" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ version: 1, values: { theme: "dark" } });
  });

  test("版本不匹配时忽略存量值", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ version: 2, values: { theme: "dark" } }, null, 2)}\n`, "utf8");

    expect(service.getInitial().values).toEqual({});
    expect((await service.getSnapshot()).values).toEqual({});
  });

  test("过滤非字符串值", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ version: 1, values: { text: "ok", number: 42, nested: { a: 1 } } }, null, 2)}\n`,
      "utf8",
    );

    expect(service.getInitial().values).toEqual({ text: "ok" });
    expect((await service.getSnapshot()).values).toEqual({ text: "ok" });
  });

  test("拒绝无效保存输入", async () => {
    await expect(service.save({ values: "theme" } as never)).resolves.toMatchObject({ status: "failed" });
    await expect(service.save(null as never)).resolves.toMatchObject({ status: "failed" });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("拒绝符号链接和非普通文件", async () => {
    const targetDirectory = `${directory}-target`;
    await mkdir(directory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "target.json"), "{}", "utf8");
    let symlinkCreated = false;
    try {
      await symlink(join(targetDirectory, "target.json"), configPath);
      symlinkCreated = true;
    } catch (error) {
      if (!(process.platform === "win32" && isNodeError(error, "EPERM"))) throw error;
    }
    if (symlinkCreated) {
      expect(service.getInitial()).toEqual({ path: configPath, exists: false, values: {} });
      await expect(service.save({ values: { theme: "dark" } })).resolves.toMatchObject({ status: "failed" });
      await rm(configPath);
    }
    await mkdir(configPath);
    expect(service.getInitial()).toEqual({ path: configPath, exists: false, values: {} });
    await rm(targetDirectory, { recursive: true, force: true });
  });

  test("并发保存串行化，全部键值最终落盘", async () => {
    const results = await Promise.all([
      service.save({ values: { a: "1" } }),
      service.save({ values: { b: "2" } }),
      service.save({ values: { c: "3" } }),
    ]);

    expect(results.every((result) => result.status === "saved")).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf8")).values).toEqual({ a: "1", b: "2", c: "3" });
  });
});

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
