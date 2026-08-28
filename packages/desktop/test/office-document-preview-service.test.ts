import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOfficeCliBinary } from "../src/main/files/office-cli-binary.ts";
import { OfficeDocumentPreviewService } from "../src/main/files/office-document-preview-service.ts";
import { ProjectStore } from "../src/main/store/project-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OfficeDocumentPreviewService", () => {
  it("使用 OfficeCLI HTML 命令渲染并复用缓存", async () => {
    const fixture = await createFixture();
    const calls: Array<{ binary: string; args: readonly string[]; cwd: string }> = [];
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async ({ binary, args, cwd }) => {
        calls.push({ binary, args, cwd });
        const output = args.at(-1);
        if (!output) throw new Error("测试输出路径缺失");
        await writeFile(output, "<main>quarterly report</main>");
      },
    });

    const first = await service.preview(7, fixture.projectId, "reports/quarterly.pptx");
    const second = await service.preview(7, fixture.projectId, "reports/quarterly.pptx");

    expect(first).toEqual({
      kind: "legacy-html",
      format: "pptx",
      path: "reports/quarterly.pptx",
      html: "<main>quarterly report</main>",
    });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binary).toBe(fixture.binary);
    expect(calls[0]?.cwd).toBe(fixture.cwd);
    expect(calls[0]?.args[0]).toBe("view");
    expect(calls[0]?.args[1]).not.toBe(join(fixture.cwd, "reports", "quarterly.pptx"));
    expect(calls[0]?.args[1]).toMatch(/\.pptx$/u);
    expect(calls[0]?.args.slice(2)).toEqual(["html", "-o", expect.any(String)]);
  });

  it("损坏缓存会被替换", async () => {
    const fixture = await createFixture();
    let runs = 0;
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      maxHtmlBytes: 64,
      resolveBinary: async () => fixture.binary,
      runner: async ({ args }) => {
        runs += 1;
        const output = args.at(-1);
        if (!output) throw new Error("测试输出路径缺失");
        await writeFile(output, `<main>run ${runs}</main>`);
      },
    });

    await service.preview(1, fixture.projectId, "reports/quarterly.pptx");
    const cachedFile = (await readdir(fixture.cacheDir)).find((name) => /^[a-f0-9]{64}\.html$/u.test(name));
    if (!cachedFile) throw new Error("测试缓存文件缺失");
    await writeFile(join(fixture.cacheDir, cachedFile), "x".repeat(65));

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.pptx")).resolves.toMatchObject({
      html: "<main>run 2</main>",
    });
    expect(runs).toBe(2);
  });

  it("源文件变化后生成新缓存", async () => {
    const fixture = await createFixture();
    let runs = 0;
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async ({ args }) => {
        runs += 1;
        const output = args.at(-1);
        if (!output) throw new Error("测试输出路径缺失");
        await writeFile(output, `<main>run ${runs}</main>`);
      },
    });

    await service.preview(1, fixture.projectId, "reports/quarterly.pptx");
    await writeFile(join(fixture.cwd, "reports", "quarterly.pptx"), "updated document bytes");
    const preview = await service.preview(1, fixture.projectId, "reports/quarterly.pptx");

    expect(runs).toBe(2);
    expect(preview.html).toBe("<main>run 2</main>");
  });

  it("等长改写并恢复 mtime 后生成新缓存", async () => {
    const fixture = await createFixture();
    let runs = 0;
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async ({ args }) => {
        runs += 1;
        const output = args.at(-1);
        if (!output) throw new Error("测试输出路径缺失");
        await writeFile(output, `<main>run ${runs}</main>`);
      },
    });
    const source = join(fixture.cwd, "reports", "quarterly.pptx");
    const before = await stat(source);
    const bytes = await readFile(source);
    bytes[0] = (bytes[0] ?? 0) ^ 1;

    await service.preview(1, fixture.projectId, "reports/quarterly.pptx");
    await writeFile(source, bytes);
    await utimes(source, before.atime, before.mtime);
    const preview = await service.preview(1, fixture.projectId, "reports/quarterly.pptx");

    expect(runs).toBe(2);
    expect(preview.html).toBe("<main>run 2</main>");
  });

  it("渲染期间源文件变化时拒绝发布旧哈希缓存", async () => {
    const fixture = await createFixture();
    const source = join(fixture.cwd, "reports", "quarterly.pptx");
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async ({ args }) => {
        const output = args.at(-1);
        if (!output) throw new Error("测试输出路径缺失");
        await writeFile(output, "<main>changed source</main>");
        await writeFile(source, "concurrent presentation update");
      },
    });

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.pptx")).rejects.toThrow("STALE_DOCUMENT");
    const cacheEntries = await readdir(fixture.cacheDir);
    expect(cacheEntries.some((name) => /^[a-f0-9]{64}\.html$/u.test(name))).toBe(false);
    expect(await readFile(source, "utf8")).toBe("concurrent presentation update");
  });

  it("源文件 A-B-A 变化时渲染内容仍来自私有 A 快照", async () => {
    const fixture = await createFixture();
    const source = join(fixture.cwd, "reports", "quarterly.pptx");
    const original = await readFile(source);
    let renderedInput: string | undefined;
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async ({ args }) => {
        const input = args[1];
        const output = args.at(-1);
        if (!input || !output) throw new Error("测试输入或输出路径缺失");
        renderedInput = await readFile(input, "utf8");
        await writeFile(source, "temporary B version");
        await writeFile(source, original);
        await writeFile(output, `<main>${renderedInput}</main>`);
      },
    });

    const preview = await service.preview(1, fixture.projectId, "reports/quarterly.pptx");

    expect(renderedInput).toBe(original.toString());
    expect(preview.html).toBe(`<main>${original.toString()}</main>`);
    expect(await readFile(source)).toEqual(original);
  });

  it.skipIf(process.platform === "win32")("拒绝通过符号链接读取 Project 外 PPTX", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.cwd, "..", "private.pptx");
    await writeFile(outside, "private presentation");
    await symlink(outside, join(fixture.cwd, "reports", "leak.pptx"));
    const runner = async () => undefined;
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner,
    });

    await expect(service.preview(1, fixture.projectId, "reports/leak.pptx")).rejects.toThrow(
      "文件路径超出 Project cwd",
    );
  });

  it("拒绝 Project 外路径和不支持的旧版 Office 格式", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async () => undefined,
    });

    await expect(service.preview(1, fixture.projectId, "../outside.docx")).rejects.toThrow("文件路径超出 Project cwd");
    await expect(service.preview(1, fixture.projectId, "reports/quarterly.docx")).rejects.toThrow(
      "不是支持的 Office 文档格式",
    );
    await expect(service.preview(1, fixture.projectId, "reports/legacy.doc")).rejects.toThrow(
      "不是支持的 Office 文档格式",
    );
  });

  it("从插件自定义 dataDir 定位二进制", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-office-binary-"));
    roots.push(root);
    const executable = join(root, process.platform === "win32" ? "officecli.exe" : "officecli");
    await writeFile(executable, "fake officecli");
    if (process.platform !== "win32") await chmod(executable, 0o755);

    await expect(resolveOfficeCliBinary({ dataDir: root })).resolves.toBe(executable);
  });

  it("内部只读预览允许自动下载时初始化二进制", async () => {
    const fixture = await createFixture();
    const configurations: unknown[] = [];
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      getConfiguration: async () => ({ autoDownload: true, version: "v1.0.143" }),
      resolveBinary: async () => undefined,
      installBinary: async (configuration) => {
        configurations.push(configuration);
        return fixture.binary;
      },
      runner: async ({ args }) => {
        const output = args.at(-1);
        if (!output) throw new Error("测试输出路径缺失");
        await writeFile(output, "<main>downloaded runtime</main>");
      },
    });

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.pptx")).resolves.toMatchObject({
      html: "<main>downloaded runtime</main>",
    });
    expect(configurations).toEqual([{ autoDownload: true, version: "v1.0.143" }]);
  });

  it("二进制缺失且关闭自动下载时提示配置内部预览 runtime", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      getConfiguration: async () => ({ autoDownload: false }),
      resolveBinary: async () => undefined,
    });

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.pptx")).rejects.toThrow(
      "未找到 OfficeCLI 只读预览 runtime",
    );
  });

  it("同一 renderer 的新预览取消旧进程", async () => {
    const fixture = await createFixture();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async ({ args, signal }) => {
        const input = args[1];
        const output = args.at(-1);
        if (!input || !output) throw new Error("测试输入或输出路径缺失");
        if ((await readFile(input, "utf8")) === "document bytes") {
          resolveStarted?.();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        await writeFile(output, "<main>budget</main>");
      },
    });

    const first = service.preview(9, fixture.projectId, "reports/quarterly.pptx");
    await started;
    const second = service.preview(9, fixture.projectId, "reports/budget.pptx");

    await expect(first).rejects.toThrow("文档预览已取消");
    await expect(second).resolves.toMatchObject({ path: "reports/budget.pptx", html: "<main>budget</main>" });
  });

  it("终止超时的 OfficeCLI 进程", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      timeoutMs: 10,
      resolveBinary: async () => fixture.binary,
      runner: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.pptx")).rejects.toThrow("OfficeCLI 渲染超时");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "meta-agent-office-preview-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const cacheDir = join(root, "cache");
  const binary = join(root, "officecli");
  await mkdir(join(cwd, "reports"), { recursive: true });
  await Promise.all([
    writeFile(binary, "fake officecli"),
    writeFile(join(cwd, "reports", "quarterly.pptx"), "document bytes"),
    writeFile(join(cwd, "reports", "budget.pptx"), "spreadsheet bytes"),
    writeFile(join(cwd, "reports", "legacy.doc"), "legacy bytes"),
  ]);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  return { binary, cacheDir, cwd: store.getCwd(project.id), projectId: project.id, store };
}
