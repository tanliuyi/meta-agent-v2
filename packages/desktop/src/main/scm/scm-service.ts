import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { TextFile } from "../../shared/contracts.ts";
import type { ScmChange, ScmChangeKind, ScmDiff, ScmDiffHunk, ScmSnapshot } from "../../shared/scm-contracts.ts";
import { resolveProjectFilePath } from "../files/project-file-path.ts";
import type { ProjectStore } from "../store/project-store.ts";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Git source-control provider. The UI consumes resources, not porcelain output. */
export class ScmService {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  async getSnapshot(projectId: string): Promise<ScmSnapshot> {
    const cwd = this.projects.getCwd(projectId);
    const [status, branch, counts] = await Promise.all([
      runGit(cwd, ["status", "--porcelain=v1", "-z"]),
      runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
      this.getAheadBehind(cwd),
    ]);
    return { projectId, branch: branch.trim() || null, ...counts, changes: parseStatus(status), fetchedAt: Date.now() };
  }

  async getDiff(projectId: string, path: string, staged = false): Promise<ScmDiff> {
    const cwd = this.projects.getCwd(projectId);
    if (!pathIsSafe(path)) throw new Error("无效的 SCM 文件路径");
    const snapshot = await this.getSnapshot(projectId);
    const change = snapshot.changes.find((item) => item.path === path && item.staged === staged);
    if (!change) throw new Error("SCM 资源已发生变化，请刷新后重试");

    const originalPath = change.originalPath ?? path;
    const [original, modified, patch] = await Promise.all([
      this.readOriginal(cwd, originalPath, change, staged),
      this.readModified(cwd, path, change, staged),
      runGit(cwd, ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--unified=0", "--", path]).catch(
        () => "",
      ),
    ]);
    return {
      path,
      original,
      modified,
      hunks: parseHunks(patch),
      binary:
        patch.includes("Binary files") || Boolean(original?.content.includes("\0") || modified?.content.includes("\0")),
    };
  }

  private async readOriginal(cwd: string, path: string, change: ScmChange, staged: boolean): Promise<TextFile | null> {
    if (change.kind === "untracked" || (staged && change.kind === "added")) return null;
    const ref = staged ? `HEAD:${path}` : `:${path}`;
    const content = await runGit(cwd, ["show", ref])
      .catch(() => runGit(cwd, ["show", `HEAD:${path}`]))
      .catch(() => null);
    return content === null ? null : textFile(path, content);
  }

  private async readModified(cwd: string, path: string, change: ScmChange, staged: boolean): Promise<TextFile | null> {
    if (change.kind === "deleted") return null;
    if (staged) {
      const content = await runGit(cwd, ["show", `:${path}`]).catch(() => null);
      return content === null ? null : textFile(path, content);
    }
    const target = resolveProjectFilePath(cwd, path);
    const info = await stat(target);
    if (!info.isFile() || info.size > GIT_MAX_BUFFER) throw new Error("文件过大，无法在工作台预览");
    return textFile(path, await readFile(target, "utf8"));
  }

  async stage(projectId: string, path: string): Promise<void> {
    await this.runPathCommand(projectId, ["add", "--", path]);
  }
  async unstage(projectId: string, path: string): Promise<void> {
    await this.runPathCommand(projectId, ["restore", "--staged", "--", path]);
  }
  async discard(projectId: string, path: string): Promise<void> {
    await this.runPathCommand(projectId, ["restore", "--", path]);
  }

  private async runPathCommand(projectId: string, args: string[]): Promise<void> {
    if (!pathIsSafe(args.at(-1) ?? "")) throw new Error("无效的 SCM 文件路径");
    await runGit(this.projects.getCwd(projectId), args);
  }

  private async getAheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
    try {
      const [behind, ahead] = (await runGit(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
        .trim()
        .split(/\s+/)
        .map(Number);
      return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }
}

function textFile(path: string, content: string): TextFile {
  return { path, content, language: extname(path).slice(1).toLowerCase() || "text" };
}

function parseHunks(patch: string): ScmDiffHunk[] {
  const hunks: ScmDiffHunk[] = [];
  const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu;
  for (const match of patch.matchAll(pattern)) {
    hunks.push({
      originalStart: Number(match[1]),
      originalLines: match[2] === undefined ? 1 : Number(match[2]),
      modifiedStart: Number(match[3]),
      modifiedLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

function pathIsSafe(path: string): boolean {
  return Boolean(path) && !path.includes("\0") && !path.startsWith("/") && !path.split("/").includes("..");
}

function parseStatus(value: string): ScmChange[] {
  const fields = value.split("\0").filter(Boolean);
  const changes: ScmChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const originalPath = code.includes("R") || code.includes("C") ? fields[++index] : undefined;
    if (code === "??") {
      changes.push({ path, kind: "untracked", staged: false });
      continue;
    }
    if (isConflict(code)) {
      changes.push({ path, ...(originalPath ? { originalPath } : {}), kind: "conflicted", staged: false });
      continue;
    }
    if (code[0] !== " ") {
      changes.push({
        path,
        ...(originalPath ? { originalPath } : {}),
        kind: changeKind(code[0] ?? " ", originalPath),
        staged: true,
      });
    }
    if (code[1] !== " ") {
      changes.push({ path, kind: changeKind(code[1] ?? " "), staged: false });
    }
  }
  return changes;
}

function isConflict(code: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
}

function changeKind(code: string, originalPath?: string): ScmChangeKind {
  if (code === "U") return "conflicted";
  if (originalPath || code === "R" || code === "C") return "renamed";
  if (code === "?") return "untracked";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  return "modified";
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
