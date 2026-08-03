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
