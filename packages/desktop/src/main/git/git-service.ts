import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, existsSync, constants as fsConstants } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type {
  GitChange,
  GitChangeKind,
  GitCommitInput,
  GitCommitResult,
  GitDiffHunk,
  GitDiffInput,
  GitDiffResult,
  GitHunkActionInput,
  GitHunkActionResult,
  GitPathsInput,
  GitRepositoryState,
  GitStatusResult,
} from "../../shared/git-contracts.ts";
import { resolveInside } from "../files/file-service.ts";
import type { ProjectStore } from "../store/project-store.ts";

const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_EXECUTABLE = resolveGitExecutable();
const GIT_DIFF_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GIT_FULL_CONTEXT_LINES = 2_147_483_647;
/** .git 内部变化合并窗口，避免 index/refs 频繁写入时反复广播。 */
const GIT_CHANGE_DEBOUNCE_MS = 300;

/** 冲突条目：x/y 任一为 U 或 DD/AA 等组合（对齐 VS Code Status 的 unmerged 语义）。 */
const UNMERGED_COMBINATIONS = new Set(["DD", "AA", "AU", "UA", "DU", "UD"]);

interface ParsedStatusLine {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

/**
 * 参考 VS Code extensions/git/src/git.ts 的 GitStatusParser：
 * `git status --porcelain=v1 -z -b -uall` 输出以 NUL 分隔，条目格式为 `XY <path>`，
 * 重命名/复制条目为 `XY <orig>\0<path>`。
 */
export class GitStatusParser {
  parse(raw: string): ParsedStatusLine[] {
    const entries: ParsedStatusLine[] = [];
    const parts = raw.split("\0");
    let i = 0;
    // 首条为 `-b` 的分支行（`## ...`），跳过。
    if (parts[i]?.startsWith("## ")) i += 1;
    for (; i < parts.length; i += 1) {
      const entry = parts[i];
      if (!entry || entry.length < 4) continue;
      const index = entry[0];
      const worktree = entry[1];
      let path = entry.slice(3);
      let originalPath: string | undefined;
      // -z 模式下重命名/复制条目为 `XY <新路径>\0<原路径>\0`（实测新路径在前）。
      if (index === "R" || index === "C" || worktree === "R" || worktree === "C") {
        path = entry.slice(3);
        i += 1;
        originalPath = parts[i] ?? "";
        if (!originalPath) continue;
      }
      // 路径以斜杠结尾表示嵌套仓库，与 VS Code 一致不展示。
      if (path.endsWith("/")) continue;
      entries.push({ index, worktree, path, originalPath });
    }
    return entries;
  }
}

function kindOf(letter: string): GitChangeKind | undefined {
  switch (letter) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return undefined;
  }
}

function isUnmerged(line: ParsedStatusLine): boolean {
  if (line.index === "U" || line.worktree === "U") return true;
  return UNMERGED_COMBINATIONS.has(`${line.index}${line.worktree}`);
}
interface GitRunOptions {
  acceptExitCodes?: readonly number[];
  stdin?: string;
  maxStdoutBytes?: number;
}

interface PatchHunk extends GitDiffHunk {
  patch: string;
}

interface WatcherEntry {
  watcher: FSWatcher;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 源代码管理 Provider 层（对应 VS Code extensions/git）：
 * 负责 git 命令执行、`git status` 解析分组，以及 `.git` 内部变化监听。
 * 只允许访问已注册 Project 的 cwd。
 */
export class GitService {
  private readonly projects: ProjectStore;
  private readonly broadcast: (projectId: string) => void;
  private readonly watchers = new Map<string, WatcherEntry>();

  constructor(projects: ProjectStore, broadcast: (projectId: string) => void) {
    this.projects = projects;
    this.broadcast = broadcast;
  }

  /** 获取仓库状态快照；非仓库 / git 缺失时返回 ok:false。 */
  async getStatus(projectId: string): Promise<GitStatusResult> {
    const cwd = this.projects.getCwd(projectId);
    try {
      const branchLineRaw = await this.runGit(["status", "--porcelain=v1", "-z", "-b", "-uall", "--", "."], cwd);
      const repositoryPrefix = (await this.runGit(["rev-parse", "--show-prefix"], cwd)).stdout
        .trim()
        .replaceAll("\\", "/");
      // 空仓库没有提交，`git log` 会失败；HEAD 短哈希仅用于展示，失败时忽略。
      let head = "";
      try {
        const logResult = await this.runGit(["log", "-1", "--format=%h"], cwd);
        head = logResult.stdout.trim().split("\n", 1)[0] ?? "";
      } catch {
        // 无提交的仓库：head 保持空。
      }
      const branchLine = branchLineRaw.stdout.split("\0", 1)[0] ?? "";
      const parsed = scopeStatusLines(new GitStatusParser().parse(branchLineRaw.stdout), repositoryPrefix);
      const { branch, ahead, behind } = parseBranchLine(branchLine);
      return { ok: true, state: buildRepositoryState(projectId, cwd, branch, head, ahead, behind, parsed) };
    } catch (error) {
      if (isGitMissingError(error)) {
        return { ok: false, reason: "git-missing", message: "未检测到 Git 可执行文件" };
      }
      if (isNotARepositoryError(error)) {
        return { ok: false, reason: "not-a-repo", message: "当前项目不是 Git 仓库" };
      }
      return { ok: false, reason: "error", message: describeGitError(error) };
    }
  }

  /** 暂存 paths（空数组 = 全部变更，对齐 VS Code 的 stageAll）。 */
  async stage(input: GitPathsInput): Promise<void> {
    const cwd = this.projects.getCwd(input.projectId);
    const paths = normalizeProjectPaths(cwd, input.paths ?? []);
    if (paths.length === 0) {
      await this.runGit(["add", "-A", "--", "."], cwd);
    } else {
      await this.runGit(["add", "--", ...paths], cwd);
    }
    this.notifyChanged(input.projectId);
  }

  /** 取消暂存 paths（空数组 = 全部）。 */
  async unstage(input: GitPathsInput): Promise<void> {
    const cwd = this.projects.getCwd(input.projectId);
    const paths = normalizeProjectPaths(cwd, input.paths ?? []);
    if (paths.length === 0) {
      await this.runGit(["reset", "-q", "--", "."], cwd);
    } else {
      await this.runGit(["reset", "-q", "--", ...paths], cwd);
    }
    this.notifyChanged(input.projectId);
  }

  /** 放弃对 paths 的更改（空数组 = 全部）。未跟踪文件会被删除，调用方负责确认。 */
  async discard(input: GitPathsInput): Promise<void> {
    const cwd = this.projects.getCwd(input.projectId);
    const paths = normalizeProjectPaths(cwd, input.paths ?? []);
    if (paths.length === 0) {
      await this.runGit(["checkout", "--", "."], cwd);
      await this.runGit(["clean", "-fd"], cwd);
    } else {
      await this.runGit(["checkout", "--", ...paths], cwd);
      await this.runGit(["clean", "-fd", "--", ...paths], cwd);
    }
    this.notifyChanged(input.projectId);
  }

  /** 提交暂存区变更。 */
  async commit(input: GitCommitInput): Promise<GitCommitResult> {
    const cwd = this.projects.getCwd(input.projectId);
    const message = input.message.trim();
    if (!message) return { ok: false, message: "提交信息不能为空" };
    try {
      await this.runGit(["commit", "-m", message], cwd);
      this.notifyChanged(input.projectId);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describeGitError(error) };
    }
  }

  /** 单个文件 diff：完整上下文负责展示，零上下文 patch 保留独立 hunk 操作边界。 */
  async diff(input: GitDiffInput): Promise<GitDiffResult> {
    return this.buildDiff(input, false);
  }

  /** 未跟踪文件 diff：旧侧为 /dev/null，文件全部行均作为新增展示。 */
  async diffUntracked(input: GitDiffInput): Promise<GitDiffResult> {
    return this.buildDiff(input, true);
  }

  /**
   * 操作单个 hunk。只接受服务端生成的内容哈希；执行前重新计算 patch，过期块不会被应用。
   * stage/unstage 只修改 index，discard 反向应用到工作区。
   */
  async applyHunk(input: GitHunkActionInput): Promise<GitHunkActionResult> {
    const cwd = this.projects.getCwd(input.projectId);
    if (input.action !== "stage" && input.action !== "unstage" && input.action !== "discard") {
      return { ok: false, reason: "error", message: "不支持的变更块操作" };
    }
    if (input.untracked && input.action !== "stage") {
      return { ok: false, reason: "error", message: "未跟踪文件只支持暂存块" };
    }
    try {
      const staged = input.action === "unstage";
      const patch = await this.loadPatch(
        { projectId: input.projectId, path: input.path, staged },
        input.action === "stage" && input.untracked === true,
        0,
      );
      const hunk = parsePatchHunks(patch).find((candidate) => candidate.id === input.hunkId);
      if (!hunk) {
        return { ok: false, reason: "stale", message: "该变更块已更新，请刷新 diff 后重试" };
      }

      const args = ["apply", "--unidiff-zero", "--whitespace=nowarn"];
      if (input.action === "stage" || input.action === "unstage") args.push("--cached");
      if (input.action === "unstage" || input.action === "discard") args.push("--reverse");
      args.push("-");
      await this.runGit(args, cwd, { stdin: hunk.patch });
      this.notifyChanged(input.projectId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "error", message: describeGitError(error) };
    }
  }

  private async buildDiff(input: GitDiffInput, untracked: boolean): Promise<GitDiffResult> {
    try {
      const [actionPatch, fullPatch] = await Promise.all([
        this.loadPatch(input, untracked, 0),
        this.loadPatch(input, untracked, GIT_FULL_CONTEXT_LINES),
      ]);
      if (actionPatch.length === 0 || fullPatch.length === 0) {
        return { ok: false, reason: "no-diff", message: "该文件没有文本差异" };
      }
      if (/^Binary files /m.test(actionPatch) || /^Binary files /m.test(fullPatch)) {
        return { ok: false, reason: "no-diff", message: "二进制文件无法展示文本差异" };
      }
      return {
        ok: true,
        patch: fullPatch,
        hunks: parsePatchHunks(actionPatch).map(({ patch: _patch, ...hunk }) => hunk),
      };
    } catch (error) {
      if (error instanceof GitOutputLimitError) {
        return { ok: false, reason: "too-large", message: "文件差异过大，无法安全加载完整 diff" };
      }
      if (isGitMissingError(error)) {
        return { ok: false, reason: "error", message: "未检测到 Git 可执行文件" };
      }
      return { ok: false, reason: "error", message: describeGitError(error) };
    }
  }

  private async loadPatch(input: GitDiffInput, untracked: boolean, contextLines: number): Promise<string> {
    const cwd = this.projects.getCwd(input.projectId);
    const path = normalizeProjectPath(cwd, input.path);
    const args = untracked
      ? ["diff", "--no-color", "--no-ext-diff", `--unified=${contextLines}`, "--no-index", "--", "/dev/null", path]
      : [
          "diff",
          ...(input.staged ? ["--cached"] : []),
          "--no-color",
          "--no-ext-diff",
          `--unified=${contextLines}`,
          "--",
          path,
        ];
    const result = await this.runGit(args, cwd, {
      acceptExitCodes: untracked ? [1] : [],
      maxStdoutBytes: GIT_DIFF_OUTPUT_LIMIT_BYTES,
    });
    return result.stdout;
  }

  /** 监听 `.git` 内部变化（index/HEAD/refs）与工作区文件变化，合并去抖后广播；引用计数，归零时关闭。 */
  watch(projectId: string): void {
    const existing = this.watchers.get(projectId);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const cwd = this.projects.getCwd(projectId);
    const gitDir = this.resolveGitDir(cwd);
    const gitTargets = gitDir
      ? [join(gitDir, "index"), join(gitDir, "HEAD"), join(gitDir, "refs")].filter((target) => existsSync(target))
      : [];
    const gitTargetRoots = gitTargets.map((target) => target.replaceAll("\\", "/"));
    const watcher = watch([...gitTargets, cwd], {
      ignoreInitial: true,
      persistent: true,
      ignored: (path) => {
        const normalized = path.replaceAll("\\", "/");
        if (
          gitTargetRoots.some(
            (target) =>
              normalized === target || normalized.startsWith(`${target}/`) || target.startsWith(`${normalized}/`),
          )
        ) {
          return false;
        }
        return /(^|\/)(?:\.git|node_modules)(?:\/|$)/u.test(normalized);
      },
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });
    const entry: WatcherEntry = { watcher, refs: 1, timer: null };
    this.watchers.set(projectId, entry);
    watcher.on("all", () => this.schedule(projectId, entry));
    watcher.on("error", () => undefined);
  }

  unwatch(projectId: string): void {
    const entry = this.watchers.get(projectId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.watchers.delete(projectId);
    void entry.watcher.close();
  }

  dispose(): void {
    for (const projectId of [...this.watchers.keys()]) this.unwatch(projectId);
  }

  private resolveGitDir(cwd: string): string | null {
    try {
      const result = this.runGitSync(["rev-parse", "--absolute-git-dir"], cwd);
      const gitDir = result.stdout.trim();
      return gitDir ? gitDir : null;
    } catch {
      return null;
    }
  }

  private schedule(projectId: string, entry: WatcherEntry): void {
    if (entry.timer !== null) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.watchers.get(projectId) !== entry) return;
      this.broadcast(projectId);
    }, GIT_CHANGE_DEBOUNCE_MS);
  }

  private notifyChanged(projectId: string): void {
    this.broadcast(projectId);
  }

  private runGit(
    args: readonly string[],
    cwd: string,
    options: GitRunOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const hasInput = options.stdin !== undefined;
      const child = spawn(GIT_EXECUTABLE, args, {
        cwd,
        stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
      const stdoutStream = child.stdout;
      const stderrStream = child.stderr;
      if (!stdoutStream || !stderrStream) {
        child.kill();
        reject(new Error("Git 子进程输出管道初始化失败"));
        return;
      }
      stdoutStream.setEncoding("utf8");
      stderrStream.setEncoding("utf8");
      if (hasInput) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(options.stdin);
      }
      let stdout = "";
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`git ${args[0] ?? "command"} 执行超时`));
      }, GIT_COMMAND_TIMEOUT_MS);
      stdoutStream.on("data", (chunk: string) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(chunk);
        if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          reject(new GitOutputLimitError(options.maxStdoutBytes));
          return;
        }
        stdout += chunk;
      });
      stderrStream.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0 || options.acceptExitCodes?.includes(code ?? -1)) {
          resolve({ stdout, stderr });
        } else {
          const error = new GitCommandError(args, code ?? 1, stderr);
          reject(error);
        }
      });
    });
  }

  private runGitSync(args: readonly string[], cwd: string): { stdout: string; stderr: string } {
    const result = spawnSync(GIT_EXECUTABLE, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.status !== 0) throw new GitCommandError(args, result.status ?? 1, result.stderr ?? "");
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

/** Electron/Node 在部分 macOS PATH 上使用 spawnp 会返回 EBADF，先手动解析绝对可执行路径。 */
function resolveGitExecutable(): string {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  for (const rawDirectory of (process.env.PATH ?? "").split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    if (!directory) continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续检查后续 PATH 项。
    }
  }
  return executable;
}

function normalizeProjectPath(cwd: string, path: string): string {
  const target = resolveInside(cwd, path);
  const normalized = relative(cwd, target).split(sep).join("/");
  if (!normalized) throw new Error("Git 路径不能为空");
  return normalized;
}

function normalizeProjectPaths(cwd: string, paths: readonly string[]): string[] {
  return paths.map((path) => normalizeProjectPath(cwd, path));
}

function scopeStatusLines(lines: ParsedStatusLine[], repositoryPrefix: string): ParsedStatusLine[] {
  if (!repositoryPrefix) return lines;
  return lines.flatMap((line): ParsedStatusLine[] => {
    if (!line.path.startsWith(repositoryPrefix)) return [];
    const path = line.path.slice(repositoryPrefix.length);
    if (!path) return [];
    const originalPath = line.originalPath?.startsWith(repositoryPrefix)
      ? line.originalPath.slice(repositoryPrefix.length)
      : undefined;
    return [{ ...line, path, ...(originalPath ? { originalPath } : {}) }];
  });
}

/** 拆分单文件零上下文 patch，并以完整 hunk 内容哈希作为防过期 ID。 */
function parsePatchHunks(patch: string): PatchHunk[] {
  const normalized = patch.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("@@ ")) starts.push(index);
  }
  if (starts.length === 0) return [];
  const header = lines.slice(0, starts[0]);
  return starts.flatMap((start, index): PatchHunk[] => {
    const hunkHeader = lines[start] ?? "";
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
    if (!match) return [];
    const end = starts[index + 1] ?? lines.length;
    const hunkPatch = `${[...header, ...lines.slice(start, end)].join("\n").replace(/\n+$/u, "")}\n`;
    return [
      {
        id: createHash("sha256").update(hunkPatch).digest("hex").slice(0, 16),
        oldStart: Number.parseInt(match[1] ?? "0", 10),
        oldLines: Number.parseInt(match[2] ?? "1", 10),
        newStart: Number.parseInt(match[3] ?? "0", 10),
        newLines: Number.parseInt(match[4] ?? "1", 10),
        patch: hunkPatch,
      },
    ];
  });
}

class GitOutputLimitError extends Error {
  constructor(limit: number) {
    super(`git diff 输出超过 ${limit} 字节限制`);
    this.name = "GitOutputLimitError";
  }
}

/** git 命令失败，携带退出码与 stderr 供上层判定原因。 */
export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    const reason = stderr.trim().split("\n")[0] ?? `git ${args[0] ?? "command"} 失败`;
    super(reason);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function isGitMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isNotARepositoryError(error: unknown): boolean {
  return error instanceof GitCommandError && /not a git repository|fatal:/i.test(error.stderr);
}

function describeGitError(error: unknown): string {
  if (error instanceof GitCommandError) {
    const lines = error.stderr.trim().split("\n");
    return lines.filter((line) => !line.startsWith("hint:")).join(" ") || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 解析 `git status -b` 的分支行：`## <branch>...<upstream> [ahead N, behind M]`。 */
export function parseBranchLine(line: string): { branch: string; ahead: number; behind: number } {
  const match = /^## (?<head>.+?)(?:\.\.\.(?<upstream>[^[]*))?(?: \[(?<trailing>[^\]]+)\])?$/.exec(line);
  let branch = match?.groups?.head ?? "";
  // 空仓库：`## No commits yet on main`
  const noCommits = /^No commits yet on (?<name>.+)$/.exec(branch);
  if (noCommits) branch = noCommits.groups?.name ?? branch;
  const trailing = match?.groups?.trailing ?? "";
  const aheadMatch = /ahead (\d+)/.exec(trailing);
  const behindMatch = /behind (\d+)/.exec(trailing);
  return {
    branch,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function buildRepositoryState(
  projectId: string,
  root: string,
  branch: string,
  head: string,
  ahead: number,
  behind: number,
  lines: ParsedStatusLine[],
): GitRepositoryState {
  // 分离 HEAD 时显示提交短哈希（对齐 VS Code repository.getHeadLabel）。
  if (branch === "HEAD (no branch)" || branch === "HEAD") branch = head || "(分离 HEAD)";
  const merge: GitChange[] = [];
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const untracked: GitChange[] = [];

  for (const line of lines) {
    if (line.index === "!" && line.worktree === "!") continue;
    if (line.index === "?" && line.worktree === "?") {
      untracked.push({ path: line.path, worktreeKind: "untracked" });
      continue;
    }
    if (isUnmerged(line)) {
      merge.push({ path: line.path, originalPath: line.originalPath, indexKind: "unmerged" });
      continue;
    }
    const indexKind = kindOf(line.index);
    const worktreeKind = kindOf(line.worktree);
    if (indexKind !== undefined && line.index !== " ") {
      staged.push({ path: line.path, originalPath: line.originalPath, indexKind });
    }
    if (worktreeKind !== undefined && line.worktree !== " ") {
      unstaged.push({ path: line.path, originalPath: line.originalPath, worktreeKind });
    }
  }

  const groups = [
    { kind: "merge", changes: merge },
    { kind: "staged", changes: staged },
    { kind: "unstaged", changes: unstaged },
    { kind: "untracked", changes: untracked },
  ] as const;

  const byPath = (left: GitChange, right: GitChange) => left.path.localeCompare(right.path);
  for (const group of groups) group.changes.sort(byPath);

  const totalChanges = lines.length;
  return {
    projectId,
    root,
    branch,
    head,
    ahead,
    behind,
    groups: [...groups],
    hasConflicts: merge.length > 0,
    totalChanges,
  };
}
