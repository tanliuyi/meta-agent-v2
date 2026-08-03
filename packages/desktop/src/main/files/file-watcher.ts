import { relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { FileChangeSet } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";

/** 文件变化事件合并窗口，参考 VS Code explorerService 的 EXPLORER_FILE_CHANGES_REACT_DELAY。 */
const FILE_CHANGES_REACT_DELAY_MS = 400;

/** 忽略 .git 与 node_modules（与文件搜索一致）。 */
const IGNORED_DIRECTORIES = /(^|[\\/])(\.git|node_modules)([\\/]|$)/u;

interface WatcherEntry {
  watcher: FSWatcher;
  refs: number;
  added: Set<string>;
  deleted: Set<string>;
  updated: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  ready: Promise<void>;
}

/**
 * 按 Project 维护 chokidar 监听，把原始事件合并成一次 FileChangeSet 广播。
 * 引用计数：watch/unwatch 配对，归零时关闭底层 watcher。
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
    const watcher = watch(cwd, {
      ignoreInitial: true,
      persistent: true,
      ignored: IGNORED_DIRECTORIES,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });
    entry = {
      watcher,
      refs: 1,
      added: new Set(),
      deleted: new Set(),
      updated: new Set(),
      timer: null,
      ready: new Promise<void>((resolve) => watcher.once("ready", () => resolve())),
    };
    this.entries.set(projectId, entry);

    const onEvent = (kind: "added" | "deleted" | "updated") => (path: string) => {
      const change = this.entries.get(projectId);
      if (!change || change !== entry) return;
      const relativePath = normalizeRelative(relative(cwd, path));
      change[kind].add(relativePath);
      this.schedule(projectId, entry);
    };
    watcher.on("add", onEvent("added"));
    watcher.on("addDir", onEvent("added"));
    watcher.on("unlink", onEvent("deleted"));
    watcher.on("unlinkDir", onEvent("deleted"));
    watcher.on("change", onEvent("updated"));
    watcher.on("error", () => undefined);
  }

  unwatch(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.entries.delete(projectId);
    void entry.watcher.close();
  }

  /** 等待底层 chokidar 完成初始扫描（测试与依赖方可用）。 */
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

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}
