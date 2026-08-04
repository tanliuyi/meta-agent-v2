import { describe, expect, it } from "vitest";
import {
  buildChangeTree,
  collectTreeChanges,
  scmTreeExpansionKey,
} from "../src/renderer/src/components/panel/source-control/scm-tree.ts";
import type { GitChange } from "../src/shared/git-contracts.ts";

function change(path: string, kind: GitChange["worktreeKind"] = "modified"): GitChange {
  return { path, worktreeKind: kind };
}

describe("buildChangeTree", () => {
  it("根文件与目录嵌套按层级构建，目录在前排序", () => {
    const tree = buildChangeTree([change("b.txt"), change("src/deep/a.ts"), change("a.txt"), change("src/b.ts")]);
    expect(tree.map((node) => node.name)).toEqual(["src", "a.txt", "b.txt"]);
    const src = tree[0];
    expect(src.directory).toBe(true);
    if (!src.directory) return;
    expect(src.children.map((node) => node.name)).toEqual(["deep", "b.ts"]);
    const deep = src.children[0];
    expect(deep.directory).toBe(true);
    if (!deep.directory) return;
    expect(deep.children.map((node) => node.name)).toEqual(["a.ts"]);
    if (deep.children[0].directory) return;
    expect(deep.children[0].change).toMatchObject({ path: "src/deep/a.ts" });
  });

  it("叶子保留 rename 的 originalPath", () => {
    const tree = buildChangeTree([{ path: "lib/new.ts", originalPath: "lib/old.ts", indexKind: "renamed" }]);
    const [directory] = tree;
    expect(directory.directory).toBe(true);
    if (!directory.directory) return;
    const [leaf] = directory.children;
    expect(leaf.directory).toBe(false);
    if (leaf.directory) return;
    expect(leaf.change).toEqual({ path: "lib/new.ts", originalPath: "lib/old.ts", indexKind: "renamed" });
  });

  it("collectTreeChanges 收集全部叶子", () => {
    const tree = buildChangeTree([change("a.ts"), change("src/b.ts"), change("src/deep/c.ts")]);
    expect(
      collectTreeChanges(tree)
        .map((item) => item.path)
        .sort(),
    ).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
  });

  it("空列表返回空树", () => {
    expect(buildChangeTree([])).toEqual([]);
  });

  it("相同目录在不同资源组使用独立展开键", () => {
    expect(scmTreeExpansionKey("staged", "src")).not.toBe(scmTreeExpansionKey("unstaged", "src"));
    expect(scmTreeExpansionKey("staged", "src")).toBe(scmTreeExpansionKey("staged", "src"));
  });
});
