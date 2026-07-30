import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MemorySettingsService,
  MISSING_MEMORY_SETTINGS_REVISION,
} from "../src/main/settings/memory-settings-service.ts";

const directories: string[] = [];

describe("MemorySettingsService", () => {
  let agentDir: string;
  let configPath: string;
  let service: MemorySettingsService;

  beforeEach(() => {
    agentDir = join(tmpdir(), `desktop-memory-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    directories.push(agentDir);
    configPath = join(agentDir, "hermes-memory-config.json");
    service = new MemorySettingsService(agentDir);
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  test("缺失配置返回扩展默认值且不创建配置文件", async () => {
    const snapshot = await service.getSnapshot();

    expect(snapshot).toMatchObject({
      path: configPath,
      exists: false,
      revision: MISSING_MEMORY_SETTINGS_REVISION,
      settings: {
        memoryMode: "policy-only",
        memoryPolicyStyle: "full",
        reviewEnabled: true,
        memoryOverflowStrategy: "auto-consolidate",
        sessionSearchVariant: "legacy",
      },
      collections: [
        { target: "memory", entries: [] },
        { target: "user", entries: [] },
        { target: "failure", entries: [] },
      ],
    });
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("保存配置时保留高级未知字段并检测外部冲突", async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ reviewEnabled: false, futureSetting: { enabled: true } }, null, 2)}\n`,
      "utf8",
    );
    const snapshot = await service.getSnapshot();
    const saved = await service.saveConfig({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, memoryPolicyStyle: "compact", nudgeInterval: 12 },
    });

    expect(saved.status).toBe("saved");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      futureSetting: { enabled: true },
      reviewEnabled: false,
      memoryPolicyStyle: "compact",
      nudgeInterval: 12,
      sessionSearch: { variant: "legacy" },
    });

    await writeFile(configPath, `${JSON.stringify({ reviewEnabled: true }, null, 2)}\n`, "utf8");
    const conflict = await service.saveConfig({
      expectedRevision: saved.status === "saved" ? saved.snapshot!.revision : "unreachable",
      settings: snapshot.settings,
    });
    expect(conflict).toMatchObject({ status: "conflict", current: { settings: { reviewEnabled: true } } });
  });

  test("通过结构化 API 管理用户资料并同步快照", async () => {
    const initial = await service.getSnapshot();
    const added = await service.mutateEntry({
      expectedRevision: initial.revision,
      action: "add",
      target: "user",
      content: "偏好简洁的技术说明",
    });

    expect(added).toMatchObject({ success: true });
    const addedEntry = added.snapshot?.collections.find(({ target }) => target === "user")?.entries[0];
    expect(addedEntry).toMatchObject({ content: "偏好简洁的技术说明" });

    const replaced = await service.mutateEntry({
      expectedRevision: added.snapshot!.revision,
      action: "replace",
      target: "user",
      entryId: addedEntry!.id,
      content: "偏好简洁、直接的技术说明",
    });
    const replacedEntry = replaced.snapshot?.collections.find(({ target }) => target === "user")?.entries[0];
    expect(replacedEntry).toMatchObject({ content: "偏好简洁、直接的技术说明" });

    const removed = await service.mutateEntry({
      expectedRevision: replaced.snapshot!.revision,
      action: "remove",
      target: "user",
      entryId: replacedEntry!.id,
    });
    expect(removed.snapshot?.collections.find(({ target }) => target === "user")?.entries).toEqual([]);
  });

  test("以稳定条目 ID 精确删除同文案的失败记忆", async () => {
    const memoryDir = join(agentDir, "pi-hermes-memory");
    await mkdir(memoryDir, { recursive: true });
    const first = "[failure] 相同内容 <!-- created=2026-01-01, last=2026-01-01, project64=b25l -->";
    const second = "[failure] 相同内容 <!-- created=2026-01-01, last=2026-01-01, project64=dHdv -->";
    await writeFile(join(memoryDir, "failures.md"), `${first}\n§\n${second}`, "utf8");
    const snapshot = await service.getSnapshot();
    const failures = snapshot.collections.find(({ target }) => target === "failure")!;

    expect(failures.entries).toHaveLength(2);
    expect(failures.entries[0]?.content).toBe(failures.entries[1]?.content);
    expect(failures.entries[0]?.id).not.toBe(failures.entries[1]?.id);

    const result = await service.mutateEntry({
      expectedRevision: snapshot.revision,
      action: "remove",
      target: "failure",
      entryId: failures.entries[0]!.id,
    });

    expect(result.success).toBe(true);
    expect(result.snapshot?.collections.find(({ target }) => target === "failure")?.entries).toHaveLength(1);
  });

  test("拒绝通过项目目录符号链接写出 projects-memory", async () => {
    const projectsRoot = join(agentDir, "projects-memory");
    const outside = `${agentDir}-outside`;
    directories.push(outside);
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, join(projectsRoot, "linked-project"), "dir");
    } catch (error) {
      if (process.platform === "win32" && isNodeError(error, "EPERM")) return;
      throw error;
    }
    service = new MemorySettingsService(agentDir, {
      listProjects: async () => [
        {
          id: "linked-id",
          kind: "project",
          name: "Linked",
          cwd: join(agentDir, "linked-project"),
          lastOpenedAt: 0,
          available: true,
        },
      ],
      getProjectCwd: () => join(agentDir, "linked-project"),
    });
    const snapshot = await service.getSnapshot();

    await expect(
      service.mutateEntry({
        expectedRevision: snapshot.revision,
        action: "add",
        target: "project",
        projectId: "linked-id",
        content: "must stay contained",
      }),
    ).rejects.toThrow("must not be a symlink");
    await expect(lstat(join(outside, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("项目列表只包含 Desktop ProjectStore 中的用户项目", async () => {
    const projectsRoot = join(agentDir, "projects-memory");
    await mkdir(join(projectsRoot, "actual"), { recursive: true });
    await mkdir(join(projectsRoot, "orphan-test-artifact"), { recursive: true });
    await writeFile(join(projectsRoot, "actual", "MEMORY.md"), "实际项目记忆", "utf8");
    await writeFile(join(projectsRoot, "orphan-test-artifact", "MEMORY.md"), "测试残留", "utf8");
    service = new MemorySettingsService(agentDir, {
      listProjects: async () => [
        {
          id: "actual-id",
          kind: "project",
          name: "已重命名的项目",
          cwd: join(tmpdir(), "actual"),
          lastOpenedAt: 0,
          available: true,
        },
      ],
      getProjectCwd: () => join(tmpdir(), "actual"),
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.projects).toMatchObject([{ id: "actual-id", name: "已重命名的项目", memoryKey: "actual" }]);
    expect(snapshot.collections.filter(({ target }) => target === "project")).toMatchObject([
      { projectId: "actual-id", projectName: "已重命名的项目", entries: [{ content: "实际项目记忆" }] },
    ]);
  });

  test("旧 memory 根配置与扩展一致地解析到 pi-hermes-memory", async () => {
    await mkdir(join(agentDir, "memory"), { recursive: true });
    await mkdir(join(agentDir, "pi-hermes-memory"), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ memoryDir: join(agentDir, "memory") })}\n`, "utf8");
    await writeFile(join(agentDir, "memory", "MEMORY.md"), "旧根内容", "utf8");
    await writeFile(join(agentDir, "pi-hermes-memory", "MEMORY.md"), "当前根内容", "utf8");

    const snapshot = await service.getSnapshot();

    expect(snapshot.collections.find(({ target }) => target === "memory")?.entries).toMatchObject([
      { content: "当前根内容" },
    ]);
  });

  test("拒绝无效配置与项目路径", async () => {
    const snapshot = await service.getSnapshot();
    await expect(
      service.saveConfig({
        expectedRevision: snapshot.revision,
        settings: { ...snapshot.settings, memoryCharLimit: 0 },
      }),
    ).rejects.toThrow("Invalid memory settings save input");
    await expect(
      service.mutateEntry({
        expectedRevision: snapshot.revision,
        action: "add",
        target: "project",
        content: "x",
      }),
    ).rejects.toThrow("Invalid memory entry mutation input");
  });
});

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
