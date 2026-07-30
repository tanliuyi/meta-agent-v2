import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileService } from "../src/main/files/file-service.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileService", () => {
  it("同一 renderer 的新 root 查询取消旧搜索", async () => {
    const { files, project } = await createService();
    const first = files.list(project.id, "", "first-target", "renderer:7");
    const second = files.list(project.id, "", "second-target", "renderer:7");

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toMatchObject([{ name: "second-target.txt", type: "file" }]);
  });

  it("不同 renderer request group 的搜索互不取消", async () => {
    const { files, project } = await createService();
    const [first, second] = await Promise.all([
      files.list(project.id, "", "first-target", "renderer:7:file-panel"),
      files.list(project.id, "", "second-target", "renderer:7:composer"),
    ]);

    expect(first).toMatchObject([{ name: "first-target.txt", type: "file" }]);
    expect(second).toMatchObject([{ name: "second-target.txt", type: "file" }]);
  });

  it("无 request scope 的直接搜索保持独立，并忽略内部目录", async () => {
    const { files, project } = await createService();
    const [first, second] = await Promise.all([
      files.list(project.id, "", "first-target"),
      files.list(project.id, "", "second-target"),
    ]);

    expect(first).toMatchObject([{ name: "first-target.txt", type: "file" }]);
    expect(second).toMatchObject([{ name: "second-target.txt", type: "file" }]);
    await expect(files.list(project.id, "", "ignored-target")).resolves.toEqual([]);
  });
});

async function createService() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-files-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await Promise.all([mkdir(join(cwd, "node_modules")), mkdir(join(cwd, ".git"))]);
  await Promise.all([
    writeFile(join(cwd, "first-target.txt"), "first"),
    writeFile(join(cwd, "second-target.txt"), "second"),
    writeFile(join(cwd, "node_modules", "ignored-target.txt"), "ignored"),
    writeFile(join(cwd, ".git", "ignored-target.txt"), "ignored"),
  ]);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  return { files: new FileService(store), project };
}
