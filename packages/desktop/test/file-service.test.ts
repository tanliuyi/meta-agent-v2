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

  it("模糊搜索按匹配质量排序：词首连续匹配优先，分散子序列也能命中", async () => {
    const { files, project } = await createService();
    await mkdir(join(project.cwd, "config"));
    await writeFile(join(project.cwd, "config", "deep-config.json"), "{}");
    await writeFile(join(project.cwd, "fig-leaf.txt"), "x");

    const results = await files.list(project.id, "", "fig");
    expect(results.map((node) => node.name)).toEqual([
      "fig-leaf.txt", // 词首连续子串
      "config", // 目录：c-o-n-f-i-g 中的分散 f-i-g
      "first-target.txt", // f-i 连续 + 尾部 g
      "deep-config.json", // 更分散且位置靠后
    ]);
  });

  it("读取图片返回 data URL，非图片格式拒绝", async () => {
    const { files, project } = await createService();
    await writeFile(join(project.cwd, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const image = await files.readImage(project.id, "pixel.png");
    expect(image.path).toBe("pixel.png");
    expect(image.mime).toBe("image/png");
    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);

    await expect(files.readImage(project.id, "first-target.txt")).rejects.toThrow("不是支持的图片格式");
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
