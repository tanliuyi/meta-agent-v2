import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitWorktreeList } from "../src/main/git-worktrees.ts";

describe("parseGitWorktreeList", () => {
  it("解析分支、detached worktree，并保留嵌套 Project 的仓库内相对路径", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /worktrees/feature",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "",
      "worktree /worktrees/prunable",
      "HEAD cccccccccccccccccccccccccccccccccccccccc",
      "branch refs/heads/stale",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\0");

    expect(parseGitWorktreeList(porcelain, "/repo/packages/app", "/repo", "packages/app/")).toEqual([
      {
        path: resolve("/repo/packages/app"),
        branch: "main",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        current: true,
      },
      {
        path: resolve("/worktrees/feature/packages/app"),
        branch: null,
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        current: false,
      },
    ]);
  });
});
