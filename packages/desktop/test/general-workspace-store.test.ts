import { mkdir, mkdtemp, readFile, rm, writeFile as writeFileRaw } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/store/project-store.ts";
import { GENERAL_WORKSPACE_ID } from "../src/shared/contracts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectStore general workspace", () => {
  it("list 返回通用工作区排在用户项目之前，不写入 projects.json", async () => {
    const { file, generalCwd, store } = await createStore();
    const userProjectDir = join(dirname(generalCwd), "user-project");
    await mkdir(userProjectDir, { recursive: true });
    const project = await store.add(userProjectDir);
    const list = await store.list();
    expect(list[0]!.id).toBe(GENERAL_WORKSPACE_ID);
    expect(list[0]!.kind).toBe("general");
    expect(list[0]!.name).toBe("对话");
    expect(list[0]!.cwd).toBe(generalCwd);
    expect(list[0]!.available).toBe(true);
    expect(list[1]!.id).toBe(project.id);

    // general 未写入 projects.json
    const metadata = JSON.parse(await readFile(join(dirname(file), "projects.json"), "utf8"));
    expect(metadata.projects).toHaveLength(1);
    expect(metadata.projects[0]!.projectId).toBe(project.id);
  });

  it("getActive 返回通用工作区", async () => {
    const { store } = await createStore();
    await store.open(GENERAL_WORKSPACE_ID);
    const active = await store.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(GENERAL_WORKSPACE_ID);
  });

  it("getActive 在重启后从 desktop-state.json 恢复", async () => {
    const { file, generalCwd } = await createStore();
    const first = new ProjectStore(file, join(dirname(file), "projects.json"), generalCwd);
    await first.load();
    await first.open(GENERAL_WORKSPACE_ID);

    // 模拟重启
    const second = new ProjectStore(file, join(dirname(file), "projects.json"), generalCwd);
    await second.load();
    const active = await second.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(GENERAL_WORKSPACE_ID);
  });

  it("getCwd 解析通用工作区目录", async () => {
    const { store, generalCwd } = await createStore();
    expect(store.getCwd(GENERAL_WORKSPACE_ID)).toBe(generalCwd);
  });

  it("open 激活通用工作区并保存 desktop-state", async () => {
    const { store, file } = await createStore();
    const result = await store.open(GENERAL_WORKSPACE_ID);
    expect(result.id).toBe(GENERAL_WORKSPACE_ID);
    expect(result.available).toBe(true);

    const state = JSON.parse(await readFile(file, "utf8"));
    expect(state.activeProjectId).toBe(GENERAL_WORKSPACE_ID);
  });

  it("remove 拒绝删除通用工作区", async () => {
    const { store } = await createStore();
    await expect(store.remove(GENERAL_WORKSPACE_ID)).rejects.toThrow("不能删除内置通用工作区");
  });

  it("setArchived / isArchived 支持通用工作区", async () => {
    const { store } = await createStore();
    expect(store.isArchived(GENERAL_WORKSPACE_ID, "thread-1")).toBe(false);
    await store.setArchived(GENERAL_WORKSPACE_ID, "thread-1", true);
    expect(store.isArchived(GENERAL_WORKSPACE_ID, "thread-1")).toBe(true);
  });

  it("getWorkbench / setWorkbench 支持通用工作区", async () => {
    const { store } = await createStore();
    const wb = store.getWorkbench(GENERAL_WORKSPACE_ID, "thread-1");
    expect(wb.panel).toBe("chat");

    await store.setWorkbench({ ...wb, panel: "files", panelOpen: true });
    const updated = store.getWorkbench(GENERAL_WORKSPACE_ID, "thread-1");
    expect(updated.panel).toBe("files");
    expect(updated.panelOpen).toBe(true);
  });

  it("未配置 generalWorkspaceCwd 时不返回通用工作区", async () => {
    const root = await mkdtemp(join(tmpdir(), "no-general-"));
    roots.push(root);
    const file = join(root, "desktop-state.json");
    const store = new ProjectStore(file);
    await store.load();

    expect(() => store.getCwd("some-id")).toThrow("Project 不存在");
    const list = await store.list();
    expect(list.some((p) => p.id === GENERAL_WORKSPACE_ID)).toBe(false);
  });

  it("未知 projectId 的 setArchived 拒绝", async () => {
    const { store } = await createStore();
    await expect(store.setArchived("nonexistent-project", "t1", true)).rejects.toThrow("Project 不存在");
  });

  it("未知 projectId 的 getWorkbench 拒绝", async () => {
    const { store } = await createStore();
    expect(() => store.getWorkbench("nonexistent-project", "t1")).toThrow("Project 不存在");
  });

  it("未知 projectId 的 setWorkbench 拒绝", async () => {
    const { store } = await createStore();
    const wb = {
      projectId: "nonexistent-project",
      threadId: "t1",
      panel: "chat" as const,
      panelOpen: false,
      panelWidth: 360,
      terminalOpen: false,
      terminalHeight: 280,
      openFiles: [],
      expandedPaths: [],
    };
    await expect(store.setWorkbench(wb)).rejects.toThrow("Project 不存在");
  });

  it("open 通用工作区但未配置 cwd 时拒绝且不写 active", async () => {
    const root = await mkdtemp(join(tmpdir(), "no-general-open-"));
    roots.push(root);
    const file = join(root, "desktop-state.json");
    // 预写入空的 desktop-state 以验证 open 失败后 activeProjectId 不变
    await mkdir(dirname(file), { recursive: true });
    await writeFileRaw(file, JSON.stringify({ version: 1, archivedThreads: {}, workbenches: {} }));
    const store = new ProjectStore(file);
    await store.load();

    await expect(store.open(GENERAL_WORKSPACE_ID)).rejects.toThrow("通用工作区未初始化");
    const state = JSON.parse(await readFile(file, "utf8"));
    expect(state.activeProjectId).toBeUndefined();
  });

  it("普通用户项目的 toProject 返回 kind=project", async () => {
    const { store } = await createStore();
    const userProjectDir = join(dirname(await mkdtemp(join(tmpdir(), "user-kind-"))), "user-project");
    await mkdir(userProjectDir, { recursive: true });
    const project = await store.add(userProjectDir);
    expect(project.kind).toBe("project");
  });

  it("未知 projectId 的 isArchived 拒绝", async () => {
    const { store } = await createStore();
    expect(() => store.isArchived("nonexistent", "t1")).toThrow("Project 不存在");
  });

  it("未知 projectId 的 removeWorkbench 拒绝", async () => {
    const { store } = await createStore();
    await expect(store.removeWorkbench("nonexistent", "t1")).rejects.toThrow("Project 不存在");
  });
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "general-store-"));
  roots.push(root);
  const generalCwd = join(root, "workspaces", "general");
  const file = join(root, "state", "desktop-state.json");
  await mkdir(generalCwd, { recursive: true });
  await mkdir(join(root, "state"), { recursive: true });
  const store = new ProjectStore(file, join(dirname(file), "projects.json"), generalCwd);
  await store.load();
  return { file, generalCwd, store };
}
