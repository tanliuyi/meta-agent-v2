import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ScmService } from "../src/main/scm/scm-service.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ScmService", () => {
  it("models index and working-tree changes as separate resources with complete revisions", async () => {
    const { cwd, projectId, service } = await createRepository();
    await writeFile(join(cwd, "example.ts"), "one\nstaged\nthree\n");
    await git(cwd, "add", "example.ts");
    await writeFile(join(cwd, "example.ts"), "one\nstaged\nworking\nthree\n");

    const snapshot = await service.getSnapshot(projectId);
    expect(snapshot.changes.filter((change) => change.path === "example.ts")).toEqual([
      { path: "example.ts", kind: "modified", staged: true },
      { path: "example.ts", kind: "modified", staged: false },
    ]);

    const staged = await service.getDiff(projectId, "example.ts", true);
    expect(staged.original?.content).toBe("one\ntwo\nthree\n");
    expect(staged.modified?.content).toBe("one\nstaged\nthree\n");
    expect(staged.hunks).toEqual([{ originalStart: 2, originalLines: 1, modifiedStart: 2, modifiedLines: 1 }]);

    const workingTree = await service.getDiff(projectId, "example.ts", false);
    expect(workingTree.original?.content).toBe("one\nstaged\nthree\n");
    expect(workingTree.modified?.content).toBe("one\nstaged\nworking\nthree\n");
    expect(workingTree.hunks).toEqual([{ originalStart: 2, originalLines: 0, modifiedStart: 3, modifiedLines: 1 }]);
  });

  it("returns an untracked file as a regular single-document preview", async () => {
    const { cwd, projectId, service } = await createRepository();
    await writeFile(join(cwd, "new-file.ts"), "export const value = 1;\n");

    const diff = await service.getDiff(projectId, "new-file.ts", false);
    expect(diff.original).toBeNull();
    expect(diff.modified).toEqual({
      path: "new-file.ts",
      content: "export const value = 1;\n",
      language: "ts",
    });
    expect(diff.hunks).toEqual([]);
  });
});

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-scm-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await git(cwd, "init");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test User");
  await writeFile(join(cwd, "example.ts"), "one\ntwo\nthree\n");
  await git(cwd, "add", "example.ts");
  await git(cwd, "commit", "-m", "initial");

  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  return { cwd, projectId: project.id, service: new ScmService(store) };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
}
