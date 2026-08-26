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

  it("为 PDF 返回受控预览 URL，并拒绝其他格式", async () => {
    const { files, project } = await createService();
    await writeFile(join(project.cwd, "report.PDF"), "%PDF-1.7");

    const preview = await files.previewPdf(project.id, "report.PDF");
    expect(preview.path).toBe("report.PDF");
    const url = new URL(preview.url);
    expect(url.protocol).toBe("meta-agent-pdf:");
    expect(url.hostname).toBe("project");
    expect(url.searchParams.get("projectId")).toBe(project.id);
    expect(url.searchParams.get("path")).toBe("report.PDF");

    await expect(files.previewPdf(project.id, "first-target.txt")).rejects.toThrow("不是 PDF 文件");
  });

  it("目录列表与搜索排除 .gitignore 中的文件与目录", async () => {
    const { files, project } = await createService();
    await writeFile(
      join(project.cwd, ".gitignore"),
      ["ignored-directory/", "*.log", "!keep.log", "docs/generated.md", "/root-only.txt"].join("\n"),
    );
    await mkdir(join(project.cwd, "ignored-directory"));
    await writeFile(join(project.cwd, "ignored-directory", "ignored-inner.txt"), "x");
    await writeFile(join(project.cwd, "app.log"), "x");
    await writeFile(join(project.cwd, "keep.log"), "x");
    await mkdir(join(project.cwd, "docs"));
    await writeFile(join(project.cwd, "docs", "generated.md"), "x");
    await writeFile(join(project.cwd, "docs", "readme.md"), "x");
    await writeFile(join(project.cwd, "root-only.txt"), "x");
    await writeFile(join(project.cwd, "nested-root.txt"), "x");

    const root = await files.list(project.id, "", "");
    expect(root.map((node) => node.name)).toEqual([
      "docs",
      ".gitignore",
      "first-target.txt",
      "keep.log",
      "nested-root.txt",
      "second-target.txt",
    ]);

    // 子目录 .gitignore 生效，`!readme.md` 重新包含 readme.md
    await writeFile(join(project.cwd, "docs", ".gitignore"), "*.md\n!readme.md\n");
    const docs = await files.list(project.id, "docs", "");
    expect(docs.map((node) => node.name)).toEqual([".gitignore", "readme.md"]);

    // 被忽略目录内不可被 `!` 重新包含
    await writeFile(join(project.cwd, "ignored-directory", ".gitignore"), "!*");
    await expect(files.list(project.id, "", "ignored-inner")).resolves.toEqual([]);
    await expect(files.list(project.id, "ignored-directory", "")).resolves.toEqual([]);

    // 搜索同样排除被忽略条目，且保留 `!` 恢复的条目
    await expect(files.list(project.id, "", "keep")).resolves.toMatchObject([{ name: "keep.log", type: "file" }]);
    await expect(files.list(project.id, "", "app")).resolves.toEqual([]);
    await expect(files.list(project.id, "", "readme")).resolves.toMatchObject([{ name: "readme.md", type: "file" }]);
  });

  it("gitignore 支持转义的注释和否定前缀", async () => {
    const { files, project } = await createService();
    await writeFile(join(project.cwd, ".gitignore"), "\\#secret.txt\n\\!important.txt\n");
    await writeFile(join(project.cwd, "#secret.txt"), "x");
    await writeFile(join(project.cwd, "!important.txt"), "x");

    await expect(files.list(project.id, "", "#secret")).resolves.toEqual([]);
    await expect(files.list(project.id, "", "!important")).resolves.toEqual([]);
    await expect(files.list(project.id, "", "")).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "#secret.txt" }),
        expect.objectContaining({ name: "!important.txt" }),
      ]),
    );
  });

  it("gitignore 支持 ** 与字符类模式", async () => {
    const { files, project } = await createService();
    await writeFile(join(project.cwd, ".gitignore"), "**/generated/\n*tmp[0-9].txt\n");
    await mkdir(join(project.cwd, "a", "b", "generated"), { recursive: true });
    await mkdir(join(project.cwd, "generated"));
    await writeFile(join(project.cwd, "a", "b", "generated", "out.js"), "x");
    await writeFile(join(project.cwd, "generated", "out.js"), "x");
    await writeFile(join(project.cwd, "a", "tmp1.txt"), "x");
    await writeFile(join(project.cwd, "a", "tmpX.txt"), "x");

    await expect(files.list(project.id, "", "out")).resolves.toEqual([]);
    await expect(files.list(project.id, "", "tmp1")).resolves.toEqual([]);
    await expect(files.list(project.id, "", "tmpX")).resolves.toMatchObject([{ name: "tmpX.txt", type: "file" }]);
    await expect(files.list(project.id, "", "generated")).resolves.toEqual([]);
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
