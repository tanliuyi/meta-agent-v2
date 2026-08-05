import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFileWatcher } from "../src/main/files/file-watcher.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";
import type { FileChangeSet } from "../src/shared/contracts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectFileWatcher", () => {
  it("合并 400ms 窗口内的事件并忽略 .git / node_modules", async () => {
    const { watcher, project, changes } = await createWatcher();
    watcher.watch(project.id);
    await waitForReady(watcher, project.id);
    await writeFile(join(project.cwd, "alpha.txt"), "a");
    await mkdir(join(project.cwd, "node_modules"));
    await mkdir(join(project.cwd, ".git"));
    await writeFile(join(project.cwd, "node_modules", "ignored.txt"), "x");
    await writeFile(join(project.cwd, ".git", "ignored.txt"), "x");
    await writeFile(join(project.cwd, "beta.txt"), "b");

    const change = await nextChange(changes);
    expect(change.projectId).toBe(project.id);
    expect(change.added).toEqual(["alpha.txt", "beta.txt"]);
    expect(change.deleted).toEqual([]);
    expect(change.updated).toEqual([]);
    watcher.unwatch(project.id);
  });

  it("区分新增、删除与更新", async () => {
    const { watcher, project, changes } = await createWatcher();
    watcher.watch(project.id);
    await waitForReady(watcher, project.id);
    await writeFile(join(project.cwd, "alpha.txt"), "a");

    const added = await nextChange(changes);
    expect(added.added).toEqual(["alpha.txt"]);

    await writeFile(join(project.cwd, "alpha.txt"), "b");
    const updated = await nextChange(changes);
    expect(updated.updated).toEqual(["alpha.txt"]);

    await rm(join(project.cwd, "alpha.txt"));
    const deleted = await nextChange(changes);
    expect(deleted.deleted).toEqual(["alpha.txt"]);
    watcher.unwatch(project.id);
  });

  it("引用计数归零后停止广播", async () => {
    const { watcher, project, changes } = await createWatcher();
    watcher.watch(project.id);
    watcher.watch(project.id);
    await waitForReady(watcher, project.id);
    watcher.unwatch(project.id);
    watcher.unwatch(project.id);
    await writeFile(join(project.cwd, "after.txt"), "a");
    await expect(noChangeFor(changes, 600)).resolves.toBe(true);
  });

  it("目录内文件变更递归上报，覆盖更新归类为 updated", async () => {
    const { watcher, project, changes } = await createWatcher();
    watcher.watch(project.id);
    await waitForReady(watcher, project.id);
    await mkdir(join(project.cwd, "nested"));
    const created = await nextChange(changes);
    expect(created.added).toEqual(["nested"]);

    // 编辑器原子保存：写临时文件后 rename 覆盖已知文件（macOS 上写文件也报 rename）。
    await writeFile(join(project.cwd, "nested", "beta.txt"), "x");
    await waitForReady(watcher, project.id);
    const added = await nextChange(changes);
    expect(added.added).toEqual(["nested/beta.txt"]);

    await writeFile(join(project.cwd, "nested", "beta.txt"), "y");
    const updated = await nextChange(changes);
    expect(updated.updated).toContain("nested/beta.txt");
    expect(updated.added).not.toContain("nested/beta.txt");
    watcher.unwatch(project.id);
  });

  it("删除含文件的目录后重建同名路径应分类为 added", async () => {
    const { watcher, project, changes } = await createWatcher();
    watcher.watch(project.id);
    await waitForReady(watcher, project.id);
    await mkdir(join(project.cwd, "sub"));
    await writeFile(join(project.cwd, "sub", "inner.txt"), "x");
    await waitForReady(watcher, project.id);
    // 消化创建事件（同一 400ms 合并窗口内广播一次），让 known 记录 sub 与 sub/inner.txt。
    const created = await nextChange(changes);
    expect(created.added).toEqual(["sub", "sub/inner.txt"]);

    await rm(join(project.cwd, "sub"), { recursive: true });
    const deleted = await nextChange(changes);
    expect(deleted.deleted).toContain("sub");

    // fs.watch recursive 不逐个上报子树删除；重建同名路径不得被误分类为 updated。
    await mkdir(join(project.cwd, "sub"));
    await writeFile(join(project.cwd, "sub", "inner.txt"), "y");
    const recreated = await nextChange(changes);
    expect(recreated.added).toContain("sub");
    expect(recreated.added).toContain("sub/inner.txt");
    expect(recreated.updated).toEqual([]);
    watcher.unwatch(project.id);
  });

  it("unwatch 立即返回不阻塞事件循环（chokidar close 曾同步遍历全部 FSWatcher）", async () => {
    const { watcher, project } = await createWatcher();
    watcher.watch(project.id);
    await waitForReady(watcher, project.id);
    const started = performance.now();
    watcher.unwatch(project.id);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

async function createWatcher() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-watch-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  const changes: FileChangeSet[] = [];
  const watcher = new ProjectFileWatcher(store, (change) => changes.push(change));
  return { watcher, project, changes };
}

function waitForReady(watcher: ProjectFileWatcher, projectId: string): Promise<void> {
  return watcher.whenReady(projectId);
}

function nextChange(changes: FileChangeSet[], timeoutMs = 3000): Promise<FileChangeSet> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const change = changes.shift();
      if (change) return resolve(change);
      if (Date.now() - started > timeoutMs) return reject(new Error("等待文件变化超时"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function noChangeFor(changes: FileChangeSet[], ms: number): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return changes.length === 0;
}
