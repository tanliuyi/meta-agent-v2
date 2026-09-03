import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectStore } from "../store/project-store.ts";

const execFileAsync = promisify(execFile);
const CHANGE_DEBOUNCE_MS = 1000;
const IGNORED_WORKTREE_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const IGNORED_GIT_DIRECTORIES = new Set(["hooks", "lfs", "objects"]);
const IGNORED_GIT_NAMES = new Set(["index.lock"]);

interface ScmWatchEntry {
  active: boolean;
  references: number;
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class ProjectScmWatcher {
  private readonly entries = new Map<string, ScmWatchEntry>();
  private readonly projects: ProjectStore;
  private readonly onChanged: (projectId: string) => void;

  constructor(projects: ProjectStore, onChanged: (projectId: string) => void) {
    this.projects = projects;
    this.onChanged = onChanged;
  }

  async watch(projectId: string): Promise<void> {
    const existing = this.entries.get(projectId);
    if (existing) {
      existing.references += 1;
      return;
    }
    const cwd = this.projects.getCwd(projectId);

    const entry: ScmWatchEntry = {
      active: true,
      references: 1,
      watchers: [],
      timer: null,
    };
    const schedule = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.onChanged(projectId);
      }, CHANGE_DEBOUNCE_MS);
    };
    this.entries.set(projectId, entry);
    try {
      const gitRoots = await resolveGitRoots(cwd);
      if (!entry.active) return;
      entry.watchers.push(
        watch(cwd, { recursive: true }, (_event, filename) => {
          const path = filename?.toString();
          if (!isWatchRoot(cwd, path) && !shouldIgnoreWorktreePath(path)) schedule();
        }),
      );
      for (const root of gitRoots) {
        entry.watchers.push(
          watch(root, { recursive: true }, (_event, filename) => {
            const path = filename?.toString();
            if (!isWatchRoot(root, path) && !shouldIgnoreGitPath(path)) schedule();
          }),
        );
      }
    } catch (error) {
      this.stopEntry(projectId, entry);
      throw error;
    }
  }

  unwatch(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    this.stopEntry(projectId, entry);
  }

  stopAll(): void {
    for (const [projectId, entry] of this.entries) this.stopEntry(projectId, entry);
  }

  private stopEntry(projectId: string, entry: ScmWatchEntry): void {
    entry.active = false;
    if (entry.timer) clearTimeout(entry.timer);
    for (const watcher of entry.watchers) watcher.close();
    this.entries.delete(projectId);
  }
}

function isWatchRoot(root: string, path?: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  const normalize = (value: string) =>
    resolve(value)
      .replace(/^\\\\\?\\/u, "")
      .replaceAll("\\", "/")
      .toLowerCase();
  return normalize(root) === normalize(path);
}

function shouldIgnoreWorktreePath(path?: string): boolean {
  if (!path) return false;
  return normalizeParts(path).some((part) => IGNORED_WORKTREE_DIRECTORIES.has(part));
}

function shouldIgnoreGitPath(path?: string): boolean {
  if (!path) return false;
  const parts = normalizeParts(path);
  const name = parts.at(-1);
  return (
    parts.some((part) => IGNORED_GIT_DIRECTORIES.has(part)) ||
    (name ? IGNORED_GIT_NAMES.has(name) || name.startsWith(".watchman-cookie-") : false)
  );
}

function normalizeParts(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

async function resolveGitRoots(cwd: string): Promise<string[]> {
  try {
    const [{ stdout: gitDir }, { stdout: commonDir }] = await Promise.all([
      execFileAsync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        windowsHide: true,
      }),
      execFileAsync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        windowsHide: true,
      }),
    ]);
    const roots = [gitDir.trim(), commonDir.trim()].map((path) => (isAbsolute(path) ? path : resolve(cwd, path)));
    return [...new Set(roots.map((path) => resolve(path)))];
  } catch {
    return [];
  }
}
