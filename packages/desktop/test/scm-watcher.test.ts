import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ScmService } from "../src/main/scm/scm-service.ts";
import { ProjectScmWatcher } from "../src/main/scm/scm-watcher.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const activeWatchers: ProjectScmWatcher[] = [];

afterEach(async () => {
  for (const watcher of activeWatchers.splice(0)) watcher.stopAll();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectScmWatcher", () => {
  it("invalidates SCM for both working-tree and index changes", async () => {
    const { cwd, projectId, watcher, changes } = await createWatcher();
    await watcher.watch(projectId);

    await writeFile(join(cwd, "example.ts"), "export const value = 2;\n");
    await expect(nextChange(changes)).resolves.toBe(projectId);

    await execFileAsync("git", ["-C", cwd, "add", "example.ts"], { windowsHide: true });
    await expect(nextChange(changes)).resolves.toBe(projectId);
    watcher.unwatch(projectId);
  });

  it("does not invalidate itself when reading the SCM snapshot", async () => {
    const { projectId, store, watcher, changes } = await createWatcher();
    await watcher.watch(projectId);

    await new ScmService(store).getSnapshot(projectId);
    await expect(noChangeFor(changes, 1300)).resolves.toBe(true);
    watcher.unwatch(projectId);
  });

  it("coalesces rapid saves and stops after the final unwatch", async () => {
    const { cwd, projectId, watcher, changes } = await createWatcher();
    await Promise.all([watcher.watch(projectId), watcher.watch(projectId)]);

    await writeFile(join(cwd, "example.ts"), "one\n");
    await writeFile(join(cwd, "example.ts"), "two\n");
    await writeFile(join(cwd, "example.ts"), "three\n");
    await expect(nextChange(changes)).resolves.toBe(projectId);
    await expect(noChangeFor(changes, 1300)).resolves.toBe(true);

    watcher.unwatch(projectId);
    watcher.unwatch(projectId);
    await writeFile(join(cwd, "example.ts"), "after\n");
    await expect(noChangeFor(changes, 300)).resolves.toBe(true);
  });
});

async function createWatcher() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-scm-watch-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await execFileAsync("git", ["-C", cwd, "init"], { windowsHide: true });
  await execFileAsync("git", ["-C", cwd, "config", "user.email", "test@example.com"], { windowsHide: true });
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "Test User"], { windowsHide: true });
  await writeFile(join(cwd, "example.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["-C", cwd, "add", "example.ts"], { windowsHide: true });
  await execFileAsync("git", ["-C", cwd, "commit", "-m", "initial"], { windowsHide: true });
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  const changes: string[] = [];
  const watcher = new ProjectScmWatcher(store, (projectId) => changes.push(projectId));
  activeWatchers.push(watcher);
  return { cwd, projectId: project.id, store, watcher, changes };
}

function nextChange(changes: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const change = changes.shift();
      if (change) return resolve(change);
      if (Date.now() - started > timeoutMs) return reject(new Error("等待 SCM 变化超时"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function noChangeFor(changes: string[], timeoutMs: number): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return changes.length === 0;
}
