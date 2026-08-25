import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

    const first = await service.preview(7, fixture.projectId, "reports/quarterly.docx");
    const second = await service.preview(7, fixture.projectId, "reports/quarterly.docx");

    expect(first).toEqual({ path: "reports/quarterly.docx", html: "<main>quarterly report</main>" });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      binary: fixture.binary,
      cwd: fixture.cwd,
      args: ["view", join(fixture.cwd, "reports", "quarterly.docx"), "html", "-o", expect.any(String)],
    });
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

    await service.preview(1, fixture.projectId, "reports/quarterly.docx");
    const cachedFile = (await readdir(fixture.cacheDir)).find((name) => /^[a-f0-9]{64}\.html$/u.test(name));
    if (!cachedFile) throw new Error("测试缓存文件缺失");
    await writeFile(join(fixture.cacheDir, cachedFile), "x".repeat(65));

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.docx")).resolves.toMatchObject({
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

    await service.preview(1, fixture.projectId, "reports/quarterly.docx");
    await writeFile(join(fixture.cwd, "reports", "quarterly.docx"), "updated document bytes");
    const preview = await service.preview(1, fixture.projectId, "reports/quarterly.docx");

    expect(runs).toBe(2);
    expect(preview.html).toBe("<main>run 2</main>");
  });

  it("拒绝 Project 外路径和不支持的旧版 Office 格式", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => fixture.binary,
      runner: async () => undefined,
    });

    await expect(service.preview(1, fixture.projectId, "../outside.docx")).rejects.toThrow("文件路径超出 Project cwd");
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

  it("插件已安装且允许自动下载时初始化二进制", async () => {
    const fixture = await createFixture();
    const configurations: unknown[] = [];
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      getConfiguration: async () => ({ installed: true, autoDownload: true, version: "v1.0.143" }),
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

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.docx")).resolves.toMatchObject({
      html: "<main>downloaded runtime</main>",
    });
    expect(configurations).toEqual([{ installed: true, autoDownload: true, version: "v1.0.143" }]);
  });

  it("二进制缺失时提示安装 pi-officecli", async () => {
    const fixture = await createFixture();
    const service = new OfficeDocumentPreviewService(fixture.store, {
      cacheDir: fixture.cacheDir,
      resolveBinary: async () => undefined,
    });

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.docx")).rejects.toThrow(
      "请安装并启用 pi-officecli 插件",
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
      runner: ({ args, signal }) => {
        const input = args[1];
        const output = args.at(-1);
        if (!output) return Promise.reject(new Error("测试输出路径缺失"));
        if (input?.endsWith("quarterly.docx")) {
          resolveStarted?.();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return writeFile(output, "<main>budget</main>");
      },
    });

    const first = service.preview(9, fixture.projectId, "reports/quarterly.docx");
    await started;
    const second = service.preview(9, fixture.projectId, "reports/budget.xlsx");

    await expect(first).rejects.toThrow("文档预览已取消");
    await expect(second).resolves.toMatchObject({ path: "reports/budget.xlsx", html: "<main>budget</main>" });
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

    await expect(service.preview(1, fixture.projectId, "reports/quarterly.docx")).rejects.toThrow("OfficeCLI 渲染超时");
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
    writeFile(join(cwd, "reports", "quarterly.docx"), "document bytes"),
    writeFile(join(cwd, "reports", "budget.xlsx"), "spreadsheet bytes"),
    writeFile(join(cwd, "reports", "legacy.doc"), "legacy bytes"),
  ]);
  const store = new ProjectStore(join(root, "state.json"));
  await store.load();
  const project = await store.add(cwd);
  return { binary, cacheDir, cwd: store.getCwd(project.id), projectId: project.id, store };
}
