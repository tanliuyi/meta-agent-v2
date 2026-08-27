import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitWorktree } from "../shared/contracts.ts";
import { samePath } from "./path-identity.ts";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export async function listGitWorktrees(projectCwd: string): Promise<GitWorktree[]> {
  try {
    const [repoRoot, prefix, porcelain] = await Promise.all([
      runGit(projectCwd, ["rev-parse", "--show-toplevel"]),
      runGit(projectCwd, ["rev-parse", "--show-prefix"]),
      runGit(projectCwd, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    const parsed = parseGitWorktreeList(porcelain, projectCwd, repoRoot.trim(), prefix.trim());
    const validated = await Promise.all(
      parsed.map(async (worktree): Promise<GitWorktree | null> => {
        try {
          const path = await realpath(worktree.path);
          if (!(await stat(path)).isDirectory()) return null;
          return { ...worktree, path };
        } catch {
          return null;
        }
      }),
    );
    return validated.flatMap((worktree) => (worktree ? [worktree] : []));
  } catch {
    return [];
  }
}

export async function resolveGitWorktree(projectCwd: string, candidate: string): Promise<string> {
  const worktrees = await listGitWorktrees(projectCwd);
  const selected = worktrees.find((worktree) => samePath(worktree.path, candidate));
  if (!selected) throw new Error("所选目录不是该 Project 的有效 Git worktree");
  return selected.path;
}

export function parseGitWorktreeList(
  porcelain: string,
  projectCwd: string,
  repoRoot: string,
  projectPrefix: string,
): GitWorktree[] {
  const normalizedProjectCwd = resolve(projectCwd);
  const normalizedRepoRoot = resolve(repoRoot);
  return porcelain.split("\0\0").flatMap((record) => {
    if (!record) return [];
    const fields = record.split("\0");
    if (fields.some((field) => field === "prunable" || field.startsWith("prunable "))) return [];
    const rootField = fields.find((field) => field.startsWith("worktree "));
    const headField = fields.find((field) => field.startsWith("HEAD "));
    if (!rootField || !headField) return [];
    const root = resolve(rootField.slice("worktree ".length));
    const path = projectPrefix ? resolve(root, projectPrefix) : root;
    const branchField = fields.find((field) => field.startsWith("branch refs/heads/"));
    return {
      path,
      branch: branchField?.slice("branch refs/heads/".length) ?? null,
      head: headField.slice("HEAD ".length),
      current: samePath(root, normalizedRepoRoot) && samePath(path, normalizedProjectCwd),
    };
  });
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(stdout);
      },
    );
  });
}
