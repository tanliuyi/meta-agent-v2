import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { FileImage, FileNode, TextFile } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { fuzzyMatch } from "./fuzzy.ts";
import { collectGitignoreLayers, type GitignoreLayer, isPathIgnored, readGitignoreLayer } from "./gitignore.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
/** 排序前放宽的候选收集上限，避免 DFS 顺序导致高分结果被截断。 */
const MAX_SEARCH_CANDIDATES = 400;
const SEARCH_YIELD_INTERVAL_MS = 8;

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
      const target = resolveInside(cwd, path);
      const layers = await collectGitignoreLayers(cwd, target);
      if (relative(cwd, target) !== "" && isPathIgnored(normalizeRelative(relative(cwd, target)), true, layers)) {
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
            if (isPathIgnored(normalizeRelative(relative(cwd, child)), entry.isDirectory(), layers)) return null;
            return {
              name: entry.name,
              path: normalizeRelative(relative(cwd, child)),
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

  /** 读取 Project 内的小型 UTF-8 文本文件。 */
  async read(projectId: string, path: string): Promise<TextFile> {
    const cwd = this.projects.getCwd(projectId);
    const target = resolveInside(cwd, path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    if (info.size > MAX_FILE_BYTES) throw new Error("文件超过 1 MiB，无法在工作台预览");
    return {
      path: normalizeRelative(relative(cwd, target)),
      content: await readFile(target, "utf8"),
      language: languageOf(target),
    };
  }

  /** 读取 Project 内的图片文件为 data URL（用于只读预览）。 */
  async readImage(projectId: string, path: string): Promise<FileImage> {
    const cwd = this.projects.getCwd(projectId);
    const target = resolveInside(cwd, path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    const mime = IMAGE_MIME[extname(target).slice(1).toLowerCase()];
    if (!mime) throw new Error("不是支持的图片格式");
    if (info.size > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB，无法预览");
    const buffer = await readFile(target);
    return {
      path: normalizeRelative(relative(cwd, target)),
      mime,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
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
        if (isPathIgnored(normalizeRelative(relative(cwd, target)), entry.isDirectory(), nextLayers)) continue;
        if (entry.isDirectory()) pending.push({ dir: target, depth: depth + 1, layers: nextLayers });
        const score = fuzzyMatch(query, entry.name);
        if (score !== null) {
          results.push({
            node: {
              name: entry.name,
              path: normalizeRelative(relative(cwd, target)),
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

function resolveInside(cwd: string, path: string): string {
  const target = resolve(cwd, path);
  const child = relative(cwd, target);
  if (child === ".." || child.startsWith(`..${sep}`) || resolve(target) === resolve(cwd, "..")) {
    throw new Error("文件路径超出 Project cwd");
  }
  return target;
}

async function directoryHasChildren(path: string): Promise<boolean> {
  return (await readdir(path)).length > 0;
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

function languageOf(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return extension || "text";
}
