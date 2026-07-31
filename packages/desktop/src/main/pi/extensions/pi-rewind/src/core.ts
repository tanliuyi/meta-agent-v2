import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PiCheckpointFileDiff, SessionCheckpointDiffResult } from "../../../../../shared/pi-rewind-contracts.ts";

export const REF_BASE = "refs/pi-checkpoints";
export const ZEROS = "0".repeat(40);
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_UNTRACKED_DIR_FILES = 200;
export const DEFAULT_MAX_CHECKPOINTS = 50;
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_DIFF_FILES = 200;
const MAX_FILE_PATCH_CHARS = 64_000;
const SNAPSHOT_STAT_CONCURRENCY = 64;
const CHECKPOINT_LOAD_CONCURRENCY = 16;

export const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".env",
  "dist",
  "build",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  ".tox",
  "__pycache__",
]);

export interface CheckpointData {
  id: string;
  commitSha: string;
  sessionId: string;
  trigger: "turn" | "tool" | "resume" | "before-restore";
  turnIndex: number;
  toolName?: string;
  description?: string;
  branch: string;
  headSha: string;
  indexTreeSha: string;
  worktreeTreeSha: string;
  timestamp: number;
  preexistingUntrackedFiles?: string[];
  skippedLargeFiles?: string[];
  skippedLargeDirs?: string[];
}

export interface CreateCheckpointOptions {
  root: string;
  id: string;
  sessionId: string;
  trigger: CheckpointData["trigger"];
  turnIndex: number;
  toolName?: string;
  description?: string;
  publish?: boolean;
  signal?: AbortSignal;
}

export interface CheckpointDiffSummary {
  files: PiCheckpointFileDiff[];
  fileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  trim?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface StatusSnapshot {
  trackedPaths: string[];
  untrackedFiles: string[];
}

interface FilesToSnapshot {
  paths: string[];
  preexistingUntrackedFiles: string[];
  skippedLargeFiles: string[];
  skippedLargeDirs: string[];
}

export function git(args: readonly string[], cwd: string, options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let abortError: Error | undefined;
    const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      abortChild(new Error(`git ${args[0] ?? "command"} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(options.trim === false ? stdout : stdout.trim());
    };
    function abortChild(error: Error): void {
      if (settled || abortError) return;
      abortError = error;
      terminateProcessTree(child, "SIGKILL");
    }
    function onAbort(): void {
      const reason = options.signal?.reason;
      abortChild(reason instanceof Error ? reason : new Error("Git operation was cancelled"));
    }

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (abortError) {
        finish(abortError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(stderr.trim() || `git ${args[0] ?? "command"} failed with code ${code}`));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  return git(["rev-parse", "--is-inside-work-tree"], cwd, { signal }).then(
    () => true,
    () => false,
  );
}

export function getRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd, { signal });
}

export function shouldIgnoreForSnapshot(path: string): boolean {
  return path.split(/[/\\]/).some((component) => IGNORED_DIR_NAMES.has(component));
}

export function isSafeId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}

export function sanitizeForRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, "_");
}

async function captureStatusSnapshot(root: string, signal?: AbortSignal): Promise<StatusSnapshot> {
  const result: StatusSnapshot = { trackedPaths: [], untrackedFiles: [] };
  const output = await git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], root, {
    trim: false,
    signal,
  });
  if (!output) return result;

  const entries = output.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    const tag = entry[0];
    if (tag === "?") {
      const path = normalizeGitPath(entry.slice(2));
      if (path && !shouldIgnoreForSnapshot(path)) result.untrackedFiles.push(path);
      continue;
    }
    if (tag === "1") {
      appendPath(result.trackedPaths, extractField(entry, 8));
      continue;
    }
    if (tag === "2") {
      appendPath(result.trackedPaths, extractField(entry, 9));
      appendPath(result.trackedPaths, entries[index + 1]);
      index += 1;
      continue;
    }
    if (tag === "u") appendPath(result.trackedPaths, extractField(entry, 10));
  }
  return result;
}

function appendPath(paths: string[], value: string | null | undefined): void {
  if (!value) return;
  const normalized = normalizeGitPath(value);
  if (normalized) paths.push(normalized);
}

function extractField(record: string, fieldNumber: number): string | null {
  let spaces = 0;
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== " ") continue;
    spaces += 1;
    if (spaces !== fieldNumber) continue;
    const path = record.slice(index + 1);
    return path || null;
  }
  return null;
}

function normalizeGitPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function detectLargeDirs(files: readonly string[], threshold: number): string[] {
  if (threshold <= 0) return [];
  const counts = new Map<string, number>();
  for (const file of files) {
    const components = file.split("/");
    for (let length = 1; length < components.length; length += 1) {
      const directory = components.slice(0, length).join("/");
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }
  const selected: string[] = [];
  for (const [directory, count] of [...counts].sort(([left], [right]) => left.length - right.length)) {
    if (count < threshold || selected.some((parent) => isPathWithin(directory, parent))) continue;
    selected.push(directory);
  }
  return selected;
}

function isPathWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function isPathWithinAny(path: string, directories: ReadonlySet<string>): boolean {
  for (const directory of directories) if (isPathWithin(path, directory)) return true;
  return false;
}

async function filesToSnapshot(root: string, signal?: AbortSignal): Promise<FilesToSnapshot> {
  const status = await captureStatusSnapshot(root, signal);
  const skippedLargeDirs = detectLargeDirs(status.untrackedFiles, MAX_UNTRACKED_DIR_FILES);
  const largeDirectories = new Set(skippedLargeDirs);
  const candidates = status.untrackedFiles.filter((path) => !isPathWithinAny(path, largeDirectories));
  const skippedLargeFiles: string[] = [];
  const includedUntracked: string[] = [];
  for (let index = 0; index < candidates.length; index += SNAPSHOT_STAT_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = candidates.slice(index, index + SNAPSHOT_STAT_CONCURRENCY);
    const entries = await Promise.all(
      batch.map(async (path) => ({ path, info: await lstat(join(root, path)).catch(() => undefined) })),
    );
    for (const { path, info } of entries) {
      signal?.throwIfAborted();
      if (!info || info.isDirectory()) continue;
      if (info.isFile() && info.size > MAX_UNTRACKED_FILE_SIZE) skippedLargeFiles.push(path);
      else includedUntracked.push(path);
    }
  }
  return {
    paths: [...new Set([...status.trackedPaths, ...includedUntracked])],
    preexistingUntrackedFiles: includedUntracked,
    skippedLargeFiles,
    skippedLargeDirs,
  };
}

export async function createCheckpoint(options: CreateCheckpointOptions): Promise<CheckpointData> {
  if (!isSafeId(options.id)) throw new Error(`Invalid checkpoint ID: ${options.id}`);
  options.signal?.throwIfAborted();
  const timestamp = Date.now();
  const created = new Date(timestamp).toISOString();
  const headSha = await git(["rev-parse", "HEAD"], options.root, { signal: options.signal }).catch(() => {
    options.signal?.throwIfAborted();
    return ZEROS;
  });
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], options.root, {
    signal: options.signal,
  }).catch(() => {
    options.signal?.throwIfAborted();
    return "unknown";
  });
  const indexTreeSha = await git(["write-tree"], options.root, { signal: options.signal });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-rewind-"));
  const temporaryIndex = join(temporaryDirectory, "index");

  try {
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    const snapshot = await filesToSnapshot(options.root, options.signal);
    if (headSha === ZEROS) await git(["read-tree", "--empty"], options.root, { env, signal: options.signal });
    else await git(["read-tree", headSha], options.root, { env, signal: options.signal });
    if (snapshot.paths.length > 0) {
      await git(["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], options.root, {
        env,
        input: `${snapshot.paths.join("\0")}\0`,
        signal: options.signal,
      });
    }
    const worktreeTreeSha = await git(["write-tree"], options.root, { env, signal: options.signal });
    const message = [
      `pi-rewind:${options.id}`,
      `sessionId ${options.sessionId}`,
      `trigger ${options.trigger}`,
      `turn ${options.turnIndex}`,
      options.toolName ? `toolName ${options.toolName}` : undefined,
      options.description ? `description ${oneLine(options.description)}` : undefined,
      `branch ${branch}`,
      `head ${headSha}`,
      `index-tree ${indexTreeSha}`,
      `worktree-tree ${worktreeTreeSha}`,
      `created ${created}`,
      `untracked ${JSON.stringify(snapshot.preexistingUntrackedFiles)}`,
      `largeFiles ${JSON.stringify(snapshot.skippedLargeFiles)}`,
      `largeDirs ${JSON.stringify(snapshot.skippedLargeDirs)}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-rewind",
      GIT_AUTHOR_EMAIL: "rewind@pi",
      GIT_AUTHOR_DATE: created,
      GIT_COMMITTER_NAME: "pi-rewind",
      GIT_COMMITTER_EMAIL: "rewind@pi",
      GIT_COMMITTER_DATE: created,
    };
    const indexCommitSha = await git(["commit-tree", indexTreeSha], options.root, {
      input: `pi-rewind-index:${options.id}\nsessionId ${options.sessionId}\ncreated ${created}`,
      env: commitEnv,
      signal: options.signal,
    });
    const commitSha = await git(["commit-tree", worktreeTreeSha, "-p", indexCommitSha], options.root, {
      input: message,
      env: commitEnv,
      signal: options.signal,
    });
    if (options.publish !== false) {
      await git(["update-ref", `${REF_BASE}/${options.id}`, commitSha], options.root, { signal: options.signal });
    }
    return {
      id: options.id,
      commitSha,
      sessionId: options.sessionId,
      trigger: options.trigger,
      turnIndex: options.turnIndex,
      ...(options.toolName ? { toolName: options.toolName } : {}),
      ...(options.description ? { description: oneLine(options.description) } : {}),
      branch,
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp,
      ...(snapshot.preexistingUntrackedFiles.length > 0
        ? { preexistingUntrackedFiles: snapshot.preexistingUntrackedFiles }
        : {}),
      ...(snapshot.skippedLargeFiles.length > 0 ? { skippedLargeFiles: snapshot.skippedLargeFiles } : {}),
      ...(snapshot.skippedLargeDirs.length > 0 ? { skippedLargeDirs: snapshot.skippedLargeDirs } : {}),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface RestoreBaseline {
  snapshot: FilesToSnapshot;
  currentPaths: Set<string>;
}

export async function restoreCheckpoint(
  root: string,
  checkpoint: CheckpointData,
  rollbackCheckpoint?: CheckpointData,
): Promise<void> {
  const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], root).catch(() => "unknown");
  if (checkpoint.branch && checkpoint.branch !== currentBranch) {
    throw new Error(
      `Checkpoint belongs to branch "${checkpoint.branch}", but the current branch is "${currentBranch}".`,
    );
  }

  const baseline = await captureRestoreBaseline(root);
  const targetPaths = await checkpointPaths(root, checkpoint);
  let mutationStarted = false;
  try {
    await applyCheckpoint(root, checkpoint, targetPaths, baseline, () => {
      mutationStarted = true;
    });
  } catch (restoreError) {
    if (!rollbackCheckpoint || !mutationStarted) throw restoreError;
    try {
      const rollbackPaths = await checkpointPaths(root, rollbackCheckpoint);
      await applyCheckpoint(
        root,
        rollbackCheckpoint,
        rollbackPaths,
        {
          snapshot: baseline.snapshot,
          currentPaths: new Set([...baseline.currentPaths, ...targetPaths]),
        },
        () => undefined,
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [restoreError, rollbackError],
        "Checkpoint restore failed and the automatic workspace rollback also failed",
      );
    }
    throw restoreError;
  }
}

async function captureRestoreBaseline(root: string): Promise<RestoreBaseline> {
  const trackedPaths = nulList(await git(["ls-files", "-z"], root, { trim: false }));
  const snapshot = await filesToSnapshot(root);
  return {
    snapshot,
    currentPaths: new Set([...trackedPaths, ...snapshot.preexistingUntrackedFiles]),
  };
}

async function checkpointPaths(root: string, checkpoint: CheckpointData): Promise<string[]> {
  return nulList(await git(["ls-tree", "-r", "-z", "--name-only", checkpoint.worktreeTreeSha], root, { trim: false }));
}

async function applyCheckpoint(
  root: string,
  checkpoint: CheckpointData,
  targetPaths: readonly string[],
  baseline: RestoreBaseline,
  mutationStarted: () => void,
): Promise<void> {
  const targetPathSet = new Set(targetPaths);
  await assertRestorePathsSafe(root, targetPaths, baseline.currentPaths, baseline.snapshot);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-rewind-restore-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    mutationStarted();
    for (const path of baseline.currentPaths) {
      if (targetPathSet.has(path)) continue;
      await removeManagedPath(root, path);
    }

    await git(["read-tree", checkpoint.worktreeTreeSha], root, { env });
    await git(["checkout-index", "--all", "--force"], root, { env });
    await git(["read-tree", "--reset", checkpoint.indexTreeSha], root);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertRestorePathsSafe(
  root: string,
  targetPaths: readonly string[],
  currentPaths: ReadonlySet<string>,
  currentSnapshot: FilesToSnapshot,
): Promise<void> {
  const skippedFiles = new Set(currentSnapshot.skippedLargeFiles);
  const skippedDirectories = new Set(currentSnapshot.skippedLargeDirs);
  for (const path of targetPaths) {
    if (skippedFiles.has(path) || isPathWithinAny(path, skippedDirectories)) {
      throw new Error(`Refusing to overwrite a file excluded from the current checkpoint: ${path}`);
    }
    if (currentPaths.has(path)) continue;
    const existing = await lstat(join(root, path)).catch(() => undefined);
    if (existing) {
      throw new Error(`Refusing to overwrite an unmanaged or ignored path: ${path}`);
    }
    let parent = dirname(path);
    while (parent && parent !== ".") {
      const parentInfo = await lstat(join(root, parent)).catch(() => undefined);
      if (parentInfo && !parentInfo.isDirectory()) {
        throw new Error(`Refusing to replace an unmanaged parent path: ${parent}`);
      }
      parent = dirname(parent);
    }
  }
}

async function removeManagedPath(root: string, path: string): Promise<void> {
  const absolutePath = join(root, path);
  const info = await lstat(absolutePath).catch(() => undefined);
  if (!info) return;
  if (info.isDirectory()) {
    throw new Error(`Refusing to replace directory with checkpoint file state: ${path}`);
  }
  await rm(absolutePath, { force: true });
  await removeEmptyParents(root, dirname(path));
}

async function removeEmptyParents(root: string, relativeDirectory: string): Promise<void> {
  let current = relativeDirectory;
  while (current && current !== ".") {
    const absolute = join(root, current);
    try {
      await rm(absolute, { recursive: false });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function nulList(output: string): string[] {
  return output.split("\0").filter(Boolean).map(normalizeGitPath);
}

export async function loadCheckpointFromRef(
  root: string,
  refName: string,
  signal?: AbortSignal,
): Promise<CheckpointData | null> {
  try {
    const commitSha = await git(["rev-parse", "--verify", `${REF_BASE}/${refName}`], root, { signal });
    const message = await git(["cat-file", "commit", commitSha], root, { trim: false, signal });
    const read = (key: string): string | undefined =>
      message.match(new RegExp(`^${escapeRegExp(key)} (.+)$`, "m"))?.[1]?.trim();
    const sessionId = read("sessionId");
    const turn = read("turn");
    const headSha = read("head");
    const indexTreeSha = read("index-tree");
    const worktreeTreeSha = read("worktree-tree");
    if (!sessionId || !turn || !headSha || !indexTreeSha || !worktreeTreeSha) return null;
    return {
      id: refName,
      commitSha,
      sessionId,
      trigger: checkpointTrigger(read("trigger")),
      turnIndex: Number.parseInt(turn, 10),
      ...(read("toolName") ? { toolName: read("toolName") } : {}),
      ...(read("description") ? { description: read("description") } : {}),
      branch: read("branch") ?? "unknown",
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp: read("created") ? Date.parse(read("created") ?? "") : 0,
      ...(jsonStringList(read("untracked")) ? { preexistingUntrackedFiles: jsonStringList(read("untracked")) } : {}),
      ...(jsonStringList(read("largeFiles")) ? { skippedLargeFiles: jsonStringList(read("largeFiles")) } : {}),
      ...(jsonStringList(read("largeDirs")) ? { skippedLargeDirs: jsonStringList(read("largeDirs")) } : {}),
    };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

function checkpointTrigger(value: string | undefined): CheckpointData["trigger"] {
  return value === "tool" || value === "resume" || value === "before-restore" ? value : "turn";
}

function jsonStringList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return undefined;
    return parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listCheckpointRefs(root: string, signal?: AbortSignal): Promise<string[]> {
  const prefix = `${REF_BASE}/`;
  const output = await git(["for-each-ref", "--format=%(refname)", prefix], root, { signal }).catch(() => {
    signal?.throwIfAborted();
    return "";
  });
  return output
    .split("\n")
    .filter(Boolean)
    .map((ref) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref));
}

export async function loadAllCheckpoints(
  root: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(root, signal);
  const relevantRefs = sessionId ? refs.filter((ref) => ref.includes(`-${sessionId}-`)) : refs;
  const checkpoints: Array<CheckpointData | null> = [];
  for (let index = 0; index < relevantRefs.length; index += CHECKPOINT_LOAD_CONCURRENCY) {
    signal?.throwIfAborted();
    checkpoints.push(
      ...(await Promise.all(
        relevantRefs
          .slice(index, index + CHECKPOINT_LOAD_CONCURRENCY)
          .map((ref) => loadCheckpointFromRef(root, ref, signal)),
      )),
    );
  }
  return checkpoints.filter(
    (checkpoint): checkpoint is CheckpointData =>
      checkpoint !== null && (sessionId === undefined || checkpoint.sessionId === sessionId),
  );
}

export async function deleteCheckpoint(root: string, id: string, signal?: AbortSignal): Promise<void> {
  if (!isSafeId(id)) throw new Error(`Invalid checkpoint ID: ${id}`);
  await git(["update-ref", "-d", `${REF_BASE}/${id}`], root, { signal });
}

export async function replaceCheckpointRefs(
  root: string,
  created: readonly CheckpointData[],
  deleted: readonly CheckpointData[],
): Promise<void> {
  for (const checkpoint of [...created, ...deleted]) {
    if (!isSafeId(checkpoint.id)) throw new Error(`Invalid checkpoint ID: ${checkpoint.id}`);
    if (!/^[0-9a-f]{40,64}$/i.test(checkpoint.commitSha)) {
      throw new Error(`Invalid checkpoint commit: ${checkpoint.id}`);
    }
  }
  const commands = [
    ...created.map((checkpoint) => `create ${REF_BASE}/${checkpoint.id} ${checkpoint.commitSha}`),
    ...deleted.map((checkpoint) => `delete ${REF_BASE}/${checkpoint.id} ${checkpoint.commitSha}`),
  ];
  if (commands.length === 0) return;
  await git(["update-ref", "--stdin"], root, { input: `${commands.join("\n")}\n` });
}

export async function deleteSessionCheckpoints(cwd: string, sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0 || !(await isGitRepo(cwd))) return;
  const root = await getRepoRoot(cwd);
  const targets = (await loadAllCheckpoints(root)).filter((checkpoint) => sessionIds.includes(checkpoint.sessionId));
  await replaceCheckpointRefs(root, [], targets);
}

export async function buildCheckpointSummary(
  root: string,
  fromTree: string,
  toTree: string,
  signal?: AbortSignal,
): Promise<CheckpointDiffSummary> {
  const numstat = await git(["diff", "--numstat", "-z", "--no-renames", fromTree, toTree], root, {
    trim: false,
    signal,
  });
  const allFiles = parseNumstat(numstat);
  return {
    files: allFiles.slice(0, MAX_DIFF_FILES),
    fileCount: allFiles.length,
    additions: allFiles.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: allFiles.reduce((total, file) => total + (file.deletions ?? 0), 0),
    truncated: allFiles.length > MAX_DIFF_FILES,
  };
}

export async function buildCheckpointFileDiff(
  root: string,
  fromTree: string,
  toTree: string,
  path: string,
): Promise<SessionCheckpointDiffResult> {
  assertSafeGitPath(path);
  const { output, truncated } = await gitBounded(
    ["diff", "--patch", "--no-color", "--no-ext-diff", "--no-renames", fromTree, toTree, "--", path],
    root,
    MAX_FILE_PATCH_CHARS,
  );
  return { patch: output.trimEnd(), truncated };
}

export async function countChangedFiles(root: string, fromTree: string, toTree: string): Promise<number> {
  const output = await git(["diff", "--name-only", "-z", "--no-renames", fromTree, toTree], root, { trim: false });
  return nulList(output).length;
}

function gitBounded(
  args: readonly string[],
  cwd: string,
  maxChars: number,
): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGKILL");
    }, GIT_COMMAND_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ output, truncated });
    };
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      const remaining = maxChars - output.length;
      if (chunk.length <= remaining) {
        output += chunk;
        return;
      }
      output += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
      child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) {
        finish(new Error(`git ${args[0] ?? "command"} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`));
      } else if (code === 0 || truncated) finish();
      else finish(new Error(stderr.trim() || `git ${args[0] ?? "command"} failed with code ${code}`));
    });
  });
}

function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && signal === "SIGKILL" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", () => {
      child.kill("SIGKILL");
    });
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when its process group has already exited.
    }
  }
  child.kill(signal);
}

function assertSafeGitPath(path: string): void {
  const normalized = normalizeGitPath(path);
  if (
    !path ||
    normalized !== path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new Error("Invalid checkpoint diff path");
  }
}

function parseNumstat(output: string): PiCheckpointFileDiff[] {
  return output.split("\0").flatMap((record) => {
    if (!record) return [];
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) return [];
    const path = normalizeGitPath(record.slice(secondTab + 1));
    if (!path) return [];
    return [
      {
        path,
        additions: parseCount(record.slice(0, firstTab)),
        deletions: parseCount(record.slice(firstTab + 1, secondTab)),
      },
    ];
  });
}

function parseCount(value: string): number | null {
  if (value === "-") return null;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? count : null;
}

export function findClosestCheckpoint(
  checkpoints: readonly CheckpointData[],
  targetTimestamp: number,
): CheckpointData | undefined {
  let closest: CheckpointData | undefined;
  for (const checkpoint of checkpoints) {
    if (checkpoint.timestamp > targetTimestamp) continue;
    if (!closest || checkpoint.timestamp > closest.timestamp) closest = checkpoint;
  }
  return closest ?? checkpoints.toSorted((left, right) => left.timestamp - right.timestamp)[0];
}
