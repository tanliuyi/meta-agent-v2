import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { FileChangeSet } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";

/** 文件变化事件合并窗口，参考 VS Code explorerService 的 EXPLORER_FILE_CHANGES_REACT_DELAY。 */
const FILE_CHANGES_REACT_DELAY_MS = 400;

/** 忽略 .git 与 node_modules（与文件搜索一致）。 */
const IGNORED_DIRECTORIES = /(^|[\\/])(\.git|node_modules)([\\/]|$)/u;

interface WatcherEntry {
  watcher: FSWatcher;
  refs: number;
  /** 已观察路径 → 是否为目录。用于区分 rename 是新增/覆盖更新，以及目录删除时清理子树。 */
  known: Map<string, boolean>;
  added: Set<string>;
  deleted: Set<string>;
  updated: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  ready: Promise<void>;
}

/** Node 运行时提供 FSWatcher.closed getter，@types/node 未声明。 */
interface ClosableWatcher extends FSWatcher {
  closed: boolean;
}

/**
 * 按 Project 维护文件监听，把原始事件合并成一次 FileChangeSet 广播。
 * 引用计数：watch/unwatch 配对，归零时关闭底层 watcher。
 *
 * 底层使用 Node fs.watch recursive（单个 FSWatcher 覆盖整棵目录树）：
 * chokidar 5 不再使用 fsevents，macOS 上每个文件/目录各开一个 fs.watch，
 * close() 会同步遍历全部 watcher 逐个关闭，在项目规模较大时阻塞主进程
 * 事件循环数秒（实测约 8800 个 FSWatcher → 13s），并容易触发 EMFILE。
 */
export class ProjectFileWatcher {
  private readonly entries = new Map<string, WatcherEntry>();
  private readonly projects: ProjectStore;
  private readonly broadcast: (change: FileChangeSet) => void;

  constructor(projects: ProjectStore, broadcast: (change: FileChangeSet) => void) {
    this.projects = projects;
    this.broadcast = broadcast;
  }

  watch(projectId: string): void {
    let entry = this.entries.get(projectId);
    if (entry) {
      entry.refs += 1;
      return;
    }
    const cwd = this.projects.getCwd(projectId);
    let watcher: FSWatcher;
    try {
      watcher = watch(cwd, { recursive: true });
    } catch {
      // 目录可能已被删除等：静默失败，下次 watch 重试（与 chokidar 的异步 error 静默一致）。
      return;
    }
    entry = {
      watcher,
      refs: 1,
      known: new Map(),
      added: new Set(),
      deleted: new Set(),
      updated: new Set(),
      timer: null,
      ready: Promise.resolve(),
    };
    this.entries.set(projectId, entry);
    // entry 就绪后才启动初始扫描（scanKnown 访问 entry.watcher）。
    entry.ready = new Promise<void>((resolve) => {
      void scanKnown(cwd, entry).finally(() => resolve());
    });

    watcher.on("change", (eventType, rawPath) => {
      if (typeof rawPath !== "string") return; // 未指定 encoding 时 filename 为 string；Buffer 分支跳过。
      const relativePath = normalizeRelative(rawPath);
      if (relativePath === "" || IGNORED_DIRECTORIES.test(relativePath)) return;
      const change = this.entries.get(projectId);
      if (!change || change !== entry) return;
      if (eventType === "change") {
        if (relativePath === basename(cwd)) {
          // 根目录自身属性变化（macOS 目录 mtime 事件）；dev+ino 比较排除与根目录同名的子目录。
          void isSameFile(cwd, join(cwd, rawPath)).then((same) => {
            if (same || this.entries.get(projectId) !== entry) return;
            if (change.known.get(relativePath) !== true) change.known.set(relativePath, false);
            change.updated.add(relativePath);
            this.schedule(projectId, change);
          });
          return;
        }
        // 保留已确认的目录标记（macOS 上目录 mtime 变化也报 change），
        // 否则目录删除时无法清理 known 子树，重建会被误分类为 updated。
        if (change.known.get(relativePath) !== true) change.known.set(relativePath, false);
        change.updated.add(relativePath);
        this.schedule(projectId, change);
        return;
      }
      // rename：stat 判断新增/删除/覆盖更新（macOS 上文件修改也常报 rename）。
      void stat(join(cwd, rawPath))
        .then((info) => {
          if (this.entries.get(projectId) !== entry) return;
          if (change.known.has(relativePath) && !change.added.has(relativePath)) {
            // 覆盖更新（如编辑器原子保存 rename 到已知文件）；
            // 同窗口内刚创建的文件保持 added 分类。
            change.updated.add(relativePath);
          } else {
            change.added.add(relativePath);
          }
          change.known.set(relativePath, info.isDirectory());
          this.schedule(projectId, change);
        })
        .catch(() => {
          if (this.entries.get(projectId) !== entry) return;
          const wasDirectory = change.known.get(relativePath);
          if (change.known.delete(relativePath)) {
            change.deleted.add(relativePath);
            // fs.watch recursive 对目录删除不逐个报告子树事件：
            // 清理 known 子树，避免同名路径重建时被误分类为 updated。
            if (wasDirectory) {
              const prefix = `${relativePath}/`;
              for (const key of change.known.keys()) {
                if (key.startsWith(prefix)) change.known.delete(key);
              }
            }
            this.schedule(projectId, change);
          }
        });
    });
    watcher.on("error", () => undefined);
  }

  unwatch(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.entries.delete(projectId);
    entry.watcher.close();
  }

  /** 等待底层 watcher 完成初始扫描（测试与依赖方可用）。 */
  whenReady(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return Promise.resolve();
    return entry.ready;
  }

  dispose(): void {
    for (const projectId of [...this.entries.keys()]) this.unwatch(projectId);
  }

  private schedule(projectId: string, entry: WatcherEntry): void {
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(projectId) !== entry) return;
      const change: FileChangeSet = {
        projectId,
        added: [...entry.added].sort(),
        deleted: [...entry.deleted].sort(),
        updated: [...entry.updated].sort(),
      };
      entry.added.clear();
      entry.deleted.clear();
      entry.updated.clear();
      this.broadcast(change);
    }, FILE_CHANGES_REACT_DELAY_MS);
  }
}

/** 初始扫描填充 known，让 rename 覆盖更新能分类为 updated 而非 added。 */
async function scanKnown(cwd: string, entry: WatcherEntry): Promise<void> {
  const pending = [cwd];
  while (pending.length > 0) {
    if ((entry.watcher as ClosableWatcher).closed) return;
    const folder = pending.pop()!;
    let children: Dirent[];
    try {
      children = await readdir(folder, { withFileTypes: true });
    } catch {
      continue; // 目录可能已删除
    }
    for (const child of children) {
      if ((entry.watcher as ClosableWatcher).closed) return;
      const absolute = join(folder, child.name as string);
      const relativePath = normalizeRelative(relative(cwd, absolute));
      if (IGNORED_DIRECTORIES.test(relativePath)) continue;
      if (child.isDirectory()) {
        pending.push(absolute);
        entry.known.set(relativePath, true);
      } else {
        entry.known.set(relativePath, false);
      }
    }
  }
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

/** 判断两个路径是否指向同一文件（dev+ino），用于识别根目录自身事件。 */
async function isSameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
    return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
  } catch {
    return false;
  }
}
