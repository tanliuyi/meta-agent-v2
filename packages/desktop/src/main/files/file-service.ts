import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { extname, parse, relative, resolve, sep } from "node:path";
import type { FileImage, FileNode, PdfDocumentPreview, TextFile } from "../../shared/contracts.ts";
import { pdfPreviewUrl } from "../../shared/pdf-preview-contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { fuzzyMatch } from "./fuzzy.ts";
import { collectGitignoreLayers, type GitignoreLayer, isPathIgnored, readGitignoreLayer } from "./gitignore.ts";
import { normalizeProjectRelativePath, resolveProjectFilePath } from "./project-file-path.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
/** 排序前放宽的候选收集上限，避免 DFS 顺序导致高分结果被截断。 */
const MAX_SEARCH_CANDIDATES = 400;
const SEARCH_YIELD_INTERVAL_MS = 8;
const FILE_OPERATION_NAME_PATTERN = /^(?!\.\.?(?:$|[\\/]))[^\\x00\\/]+$/u;

type FileClipboard = {
  projectId: string;
  paths: string[];
  cut: boolean;
};

const IMAGE_MIME: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** 只允许访问已注册 Project cwd 内部文件的工作区文件服务。 */
export class FileService {
  private readonly projects: ProjectStore;
  private readonly activeRequests = new Map<string, object>();
  private clipboard: FileClipboard | undefined;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  /** 列出目录；提供 query 时在 Project 内执行有上限的名称搜索。 */
  async list(projectId: string, path = "", query = "", requestScope?: string): Promise<FileNode[]> {
    const cwd = this.projects.getCwd(projectId);
    const normalizedQuery = query.trim().toLowerCase();
    const requestGroup = normalizedQuery ? "root" : path || "root";
    const requestKey = requestScope === undefined ? undefined : `${requestScope}\0${projectId}\0${requestGroup}`;
    const requestToken = requestKey === undefined ? undefined : {};
    if (requestKey !== undefined && requestToken !== undefined) this.activeRequests.set(requestKey, requestToken);
    const isCancelled = () => requestKey !== undefined && this.activeRequests.get(requestKey) !== requestToken;

    try {
      if (normalizedQuery) {
        const searchResults = await this.search(cwd, normalizedQuery, isCancelled);
        return searchResults;
      }
      const target = resolveProjectFilePath(cwd, path);
      const layers = await collectGitignoreLayers(cwd, target);
      if (
        relative(cwd, target) !== "" &&
        isPathIgnored(normalizeProjectRelativePath(relative(cwd, target)), true, layers)
      ) {
        return [];
      }
      const entries = await readdir(target, { withFileTypes: true });
      const nodes = await Promise.all(
        entries
          .sort(
            (left, right) =>
              Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
          )
          .map(async (entry): Promise<FileNode | null> => {
            if (entry.name === ".git" || entry.name === "node_modules") return null;
            const child = resolve(target, entry.name);
            if (isPathIgnored(normalizeProjectRelativePath(relative(cwd, child)), entry.isDirectory(), layers))
              return null;
            return {
              name: entry.name,
              path: normalizeProjectRelativePath(relative(cwd, child)),
              type: entry.isDirectory() ? "directory" : "file",
              hasChildren: entry.isDirectory() ? await directoryHasChildren(child) : undefined,
            } satisfies FileNode;
          }),
      );
      return nodes.filter((node): node is FileNode => node !== null);
    } finally {
      if (requestKey !== undefined && this.activeRequests.get(requestKey) === requestToken) {
        this.activeRequests.delete(requestKey);
      }
    }
  }

  async copy(projectId: string, paths: string[]): Promise<void> {
    this.clipboard = { projectId, paths: paths.map((path) => this.normalizeExistingPath(projectId, path)), cut: false };
  }

  async cut(projectId: string, paths: string[]): Promise<void> {
    this.clipboard = { projectId, paths: paths.map((path) => this.normalizeExistingPath(projectId, path)), cut: true };
  }

  async paste(projectId: string, destinationPath: string): Promise<void> {
    const clipboard = this.clipboard;
    if (!clipboard) throw new Error("剪贴板为空");
    if (clipboard.projectId !== projectId) throw new Error("只能在同一个 Project 中粘贴文件");
    const cwd = this.projects.getCwd(projectId);
    const destination = resolveProjectFilePath(cwd, destinationPath);
    const destinationInfo = await stat(destination);
    if (!destinationInfo.isDirectory()) throw new Error("粘贴目标不是目录");
    for (const source of clipboard.paths) {
      const sourceName = source.split(/[\\/]/u).filter(Boolean).at(-1);
      if (!sourceName) throw new Error("无效的源文件路径");
      let target = resolveProjectFilePath(
        cwd,
        normalizeProjectRelativePath(relative(cwd, resolve(destination, sourceName))),
      );
      const sourceInfo = await stat(source);
      if (sourceInfo.isDirectory() && target.startsWith(`${source}${sep}`)) {
        throw new Error("不能将目录粘贴到自身内部");
      }
      const targetExists = await stat(target).then(
        () => true,
        () => false,
      );
      if (targetExists) {
        if (clipboard.cut) throw new Error(`目标已存在: ${sourceName}`);
        target = await this.findAvailableCopyTarget(cwd, destination, sourceName);
      }
      if (clipboard.cut) await rename(source, target);
      else if (sourceInfo.isDirectory()) await cp(source, target, { recursive: true });
      else await copyFile(source, target);
    }
    if (clipboard.cut) this.clipboard = undefined;
  }

  async createFolder(projectId: string, parentPath: string, name: string): Promise<void> {
    const target = this.resolveNamedChild(projectId, parentPath, name);
    await mkdir(target);
  }

  async rename(projectId: string, path: string, name: string): Promise<void> {
    const cwd = this.projects.getCwd(projectId);
    const source = resolveProjectFilePath(cwd, path);
    if (source === resolve(cwd)) throw new Error("不能重命名 Project 根目录");
    const parent = relative(cwd, resolve(source, ".."));
    const target = this.resolveNamedChild(projectId, normalizeProjectRelativePath(parent), name);
    await stat(target).then(
      () => {
        throw new Error(`目标已存在: ${name}`);
      },
      () => rename(source, target),
    );
  }

  async remove(projectId: string, path: string): Promise<void> {
    const cwd = this.projects.getCwd(projectId);
    const target = resolveProjectFilePath(cwd, path);
    if (target === resolve(cwd)) throw new Error("不能删除 Project 根目录");
    await rm(target, { recursive: true, force: false });
  }

  private async findAvailableCopyTarget(cwd: string, destination: string, sourceName: string): Promise<string> {
    const parsed = parse(sourceName);
    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? " copy" : ` copy ${index}`;
      const candidate = resolveProjectFilePath(
        cwd,
        normalizeProjectRelativePath(relative(cwd, resolve(destination, `${parsed.name}${suffix}${parsed.ext}`))),
      );
      const exists = await stat(candidate).then(
        () => true,
        () => false,
      );
      if (!exists) return candidate;
    }
  }

  private normalizeExistingPath(projectId: string, path: string): string {
    const cwd = this.projects.getCwd(projectId);
    return resolveProjectFilePath(cwd, path);
  }

  private resolveNamedChild(projectId: string, parentPath: string, name: string): string {
    if (!FILE_OPERATION_NAME_PATTERN.test(name.trim())) throw new Error("名称不能包含路径分隔符或目录穿越字符");
    const cwd = this.projects.getCwd(projectId);
    return resolveProjectFilePath(
      cwd,
      normalizeProjectRelativePath(relative(cwd, resolve(cwd, parentPath, name.trim()))),
    );
  }

  /** 读取 Project 内的小型 UTF-8 文本文件。 */
  async read(projectId: string, path: string): Promise<TextFile> {
    const cwd = this.projects.getCwd(projectId);
    const target = resolveProjectFilePath(cwd, path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (info.size > MAX_FILE_BYTES) throw new Error("文件超过 1 MiB，无法在工作台预览");
    return {
      path: normalizeProjectRelativePath(relative(cwd, target)),
      content: await readFile(target, "utf8"),
      language: languageOf(target),
    };
  }

  /** 读取 Project 内的图片文件为 data URL（用于只读预览）。 */
  async readImage(projectId: string, path: string): Promise<FileImage> {
    const cwd = this.projects.getCwd(projectId);
    const target = resolveProjectFilePath(cwd, path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    const mime = IMAGE_MIME[extname(target).slice(1).toLowerCase()];
    if (!mime) throw new Error("不是支持的图片格式");
    if (info.size > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB，无法预览");
    const buffer = await readFile(target);
    return {
      path: normalizeProjectRelativePath(relative(cwd, target)),
      mime,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
    };
  }

  /** 校验 Project 内的 PDF，并返回 Electron 内置查看器使用的受控 URL。 */
  async previewPdf(projectId: string, path: string): Promise<PdfDocumentPreview> {
    const cwd = this.projects.getCwd(projectId);
    const target = resolveProjectFilePath(cwd, path);
    if (extname(target).toLowerCase() !== ".pdf") throw new Error("不是 PDF 文件");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    const normalizedPath = normalizeProjectRelativePath(relative(cwd, target));
    return {
      path: normalizedPath,
      url: pdfPreviewUrl(projectId, normalizedPath),
    };
  }

  private async search(cwd: string, query: string, isCancelled: () => boolean): Promise<FileNode[]> {
    const results: Array<{ node: FileNode; score: number }> = [];
    const pending: Array<{ dir: string; depth: number; layers: readonly GitignoreLayer[] }> = [
      { dir: cwd, depth: 0, layers: [] },
    ];
    let nextYieldAt = performance.now() + SEARCH_YIELD_INTERVAL_MS;
    while (pending.length > 0 && results.length < MAX_SEARCH_CANDIDATES) {
      if (isCancelled()) return [];
      const current = pending.pop();
      if (!current) break;
      const { dir, depth, layers } = current;
      const entries = await readdir(dir, { withFileTypes: true });
      if (isCancelled()) return [];
      const ownLayer = await readGitignoreLayer(dir, depth);
      const nextLayers = ownLayer ? [...layers, ownLayer] : layers;
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const target = resolve(dir, entry.name);
        if (isPathIgnored(normalizeProjectRelativePath(relative(cwd, target)), entry.isDirectory(), nextLayers))
          continue;
        if (entry.isDirectory()) pending.push({ dir: target, depth: depth + 1, layers: nextLayers });
        const score = fuzzyMatch(query, entry.name);
        if (score !== null) {
          results.push({
            node: {
              name: entry.name,
              path: normalizeProjectRelativePath(relative(cwd, target)),
              type: entry.isDirectory() ? "directory" : "file",
              hasChildren: entry.isDirectory(),
            },
            score,
          });
          if (results.length >= MAX_SEARCH_CANDIDATES) break;
        }
        if (performance.now() < nextYieldAt) continue;
        await yieldToEventLoop();
        if (isCancelled()) return [];
        nextYieldAt = performance.now() + SEARCH_YIELD_INTERVAL_MS;
      }
    }
    return results
      .sort(
        (left, right) =>
          right.score - left.score ||
          Number(right.node.type === "directory") - Number(left.node.type === "directory") ||
          left.node.name.localeCompare(right.node.name),
      )
      .slice(0, MAX_SEARCH_RESULTS)
      .map(({ node }) => node);
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
}

async function directoryHasChildren(path: string): Promise<boolean> {
  return (await readdir(path)).length > 0;
}

function languageOf(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return extension || "text";
}
