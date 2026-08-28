import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { OfficeDocumentPreview } from "../../shared/office-document-contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import {
  installOfficeCliBinary,
  type OfficeCliLocationConfiguration,
  resolveOfficeCliBinary,
} from "./office-cli-binary.ts";
import { normalizeProjectRelativePath, resolveProjectFilePath } from "./project-file-path.ts";

const OFFICE_DOCUMENT_EXTENSIONS = new Set([".pptx"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_HTML_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_OUTPUT_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 64;

interface OfficeCliRunInput {
  binary: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
}

type OfficeCliRunner = (input: OfficeCliRunInput) => Promise<void>;

interface OfficeDocumentPreviewServiceOptions {
  cacheDir: string;
  getConfiguration?(): Promise<OfficeCliLocationConfiguration>;
  resolveBinary?(configuration: OfficeCliLocationConfiguration): Promise<string | undefined>;
  installBinary?(configuration: OfficeCliLocationConfiguration): Promise<string>;
  runner?: OfficeCliRunner;
  timeoutMs?: number;
  maxHtmlBytes?: number;
}

/** 使用已安装的 OfficeCLI 将 Project 内 Office 文档渲染为隔离预览 HTML。 */
export class OfficeDocumentPreviewService {
  private readonly projects: ProjectStore;
  private readonly options: OfficeDocumentPreviewServiceOptions;
  private readonly activeRequests = new Map<number, AbortController>();

  constructor(projects: ProjectStore, options: OfficeDocumentPreviewServiceOptions) {
    this.projects = projects;
    this.options = options;
  }

  async preview(ownerId: number, projectId: string, path: string): Promise<OfficeDocumentPreview> {
    this.cancelOwner(ownerId);
    const controller = new AbortController();
    this.activeRequests.set(ownerId, controller);
    let temporaryOutput: string | undefined;
    let temporarySource: string | undefined;

    try {
      const configuredCwd = this.projects.getCwd(projectId);
      const candidate = resolveProjectFilePath(configuredCwd, path);
      const extension = extname(candidate).toLowerCase();
      if (!OFFICE_DOCUMENT_EXTENSIONS.has(extension)) throw new Error("不是支持的 Office 文档格式");
      const cwd = await realpath(configuredCwd);
      const target = await realpath(candidate);
      resolveProjectFilePath(cwd, target);
      const format = "pptx" as const;
      const sourceInfo = await stat(target);
      if (!sourceInfo.isFile()) throw new Error("目标不是文件");

      const configuration = await this.getConfiguration();
      let binary = await (this.options.resolveBinary ?? resolveOfficeCliBinary)(configuration);
      if (!binary && configuration.autoDownload !== false) {
        binary = await (this.options.installBinary ?? installOfficeCliBinary)(configuration);
      }
      if (!binary) {
        throw new Error("未找到 OfficeCLI 只读预览 runtime，请配置 binaryPath 或开启自动下载");
      }
      const binaryInfo = await stat(binary);
      if (controller.signal.aborted) throw new Error("文档预览已取消");

      const sourceBytes = await readFile(target);
      const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
      const cacheKey = createHash("sha256")
        .update(target)
        .update("\0")
        .update(sourceSha256)
        .update("\0")
        .update(binary)
        .update("\0")
        .update(String(binaryInfo.mtimeMs))
        .digest("hex");
      const output = join(this.options.cacheDir, `${cacheKey}.html`);
      let cachedHtml: string | undefined;
      try {
        cachedHtml = await readPreviewHtml(output, this.options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES);
      } catch {
        await rm(output, { force: true }).catch(() => undefined);
      }
      if (cachedHtml !== undefined) {
        return {
          kind: "legacy-html",
          format,
          path: normalizeProjectRelativePath(relative(cwd, target)),
          html: cachedHtml,
        };
      }

      await mkdir(this.options.cacheDir, { recursive: true });
      temporarySource = join(this.options.cacheDir, `${cacheKey}.${randomUUID()}.pptx`);
      await writeFile(temporarySource, sourceBytes, { flag: "wx", mode: 0o400 });
      temporaryOutput = join(this.options.cacheDir, `${cacheKey}.${randomUUID()}.html`);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        await (this.options.runner ?? runOfficeCli)({
          binary,
          args: ["view", temporarySource, "html", "-o", temporaryOutput],
          cwd,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new Error("OfficeCLI 渲染超时");
        if (controller.signal.aborted) throw new Error("文档预览已取消");
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const renderedSourceSha256 = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      if (renderedSourceSha256 !== sourceSha256) {
        throw new Error("STALE_DOCUMENT");
      }
      const html = await readPreviewHtml(temporaryOutput, this.options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES);
      try {
        await rename(temporaryOutput, output);
        temporaryOutput = undefined;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
      await prunePreviewCache(this.options.cacheDir).catch(() => undefined);
      return {
        kind: "legacy-html",
        format,
        path: normalizeProjectRelativePath(relative(cwd, target)),
        html,
      };
    } finally {
      if (temporarySource) await rm(temporarySource, { force: true }).catch(() => undefined);
      if (temporaryOutput) await rm(temporaryOutput, { force: true }).catch(() => undefined);
      if (this.activeRequests.get(ownerId) === controller) this.activeRequests.delete(ownerId);
    }
  }

  cancelOwner(ownerId: number): void {
    this.activeRequests.get(ownerId)?.abort();
    this.activeRequests.delete(ownerId);
  }

  private async getConfiguration(): Promise<OfficeCliLocationConfiguration> {
    try {
      const configuration = await this.options.getConfiguration?.();
      return {
        binaryPath: configuration?.binaryPath?.trim() || undefined,
        dataDir: configuration?.dataDir?.trim() || undefined,
        version: configuration?.version?.trim() || undefined,
        autoDownload: configuration?.autoDownload,
      };
    } catch {
      return {};
    }
  }
}

async function readPreviewHtml(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error("OfficeCLI 未生成预览内容");
  if (info.size > maxBytes) {
    throw new Error(`Office 文档预览超过 ${formatMiB(maxBytes)} MiB，无法显示`);
  }
  return readFile(path, "utf8");
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function runOfficeCli(input: OfficeCliRunInput): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(input.binary, [...input.args], {
      cwd: input.cwd,
      signal: input.signal,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const errorChunks: Buffer[] = [];
    let errorBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= MAX_ERROR_OUTPUT_BYTES) return;
      const remaining = MAX_ERROR_OUTPUT_BYTES - errorBytes;
      const captured = chunk.subarray(0, remaining);
      errorChunks.push(captured);
      errorBytes += captured.length;
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      const details = Buffer.concat(errorChunks).toString("utf8").trim();
      rejectRun(
        new Error(
          details || `OfficeCLI 渲染失败${code === null ? `（signal: ${signal ?? "unknown"}）` : `（exit: ${code}）`}`,
        ),
      );
    });
  });
}

async function prunePreviewCache(cacheDir: string): Promise<void> {
  const entries = await readdir(cacheDir, { withFileTypes: true });
  const cachedFiles = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.html$/u.test(entry.name))
      .map(async (entry) => ({ name: entry.name, mtimeMs: (await stat(join(cacheDir, entry.name))).mtimeMs })),
  );
  cachedFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(
    cachedFiles.slice(MAX_CACHE_ENTRIES).map((entry) => rm(join(cacheDir, entry.name), { force: true })),
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
