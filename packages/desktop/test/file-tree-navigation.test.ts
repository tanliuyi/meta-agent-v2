import { describe, expect, it } from "vitest";
import {
  buildFileTreeStickyModel,
  type FileTreeRow,
  fileTreeKeyNavigation,
  fileTreeStickyRows,
} from "../src/renderer/src/components/panel/files/file-tree-navigation.ts";

function rows(...specs: Array<[string, number, boolean, "file" | "directory"]>): FileTreeRow[] {
  return specs.map(([path, depth, open, type]) => ({
    kind: "node",
    path,
    depth,
    open,
    node: { name: path.split("/").at(-1) ?? path, path, type },
  }));
}

describe("fileTreeKeyNavigation", () => {
  const tree = rows(
    ["src", 0, true, "directory"],
    ["src/index.ts", 1, false, "file"],
    ["src/app", 1, true, "directory"],
    ["src/app/main.ts", 2, false, "file"],
    ["lib", 0, false, "directory"],
  );

  it("ArrowDown/Up 移动到相邻可见行", () => {
    expect(fileTreeKeyNavigation(tree, 0, "ArrowDown")).toEqual({ kind: "move", index: 1 });
    expect(fileTreeKeyNavigation(tree, 1, "ArrowUp")).toEqual({ kind: "move", index: 0 });
    expect(fileTreeKeyNavigation(tree, 4, "ArrowDown")).toBeNull();
  });

  it("Home/End 跳到首尾", () => {
    expect(fileTreeKeyNavigation(tree, 2, "Home")).toEqual({ kind: "move", index: 0 });
    expect(fileTreeKeyNavigation(tree, 0, "End")).toEqual({ kind: "move", index: 4 });
  });

  it("ArrowRight 展开未展开目录，已展开时移动到第一个子节点", () => {
    expect(fileTreeKeyNavigation(tree, 4, "ArrowRight")).toEqual({ kind: "toggle" });
    expect(fileTreeKeyNavigation(tree, 0, "ArrowRight")).toEqual({ kind: "move", index: 1 });
    expect(fileTreeKeyNavigation(tree, 1, "ArrowRight")).toBeNull();
  });

  it("ArrowLeft 收起已展开目录，否则移动到父级", () => {
    expect(fileTreeKeyNavigation(tree, 0, "ArrowLeft")).toEqual({ kind: "toggle" });
    expect(fileTreeKeyNavigation(tree, 1, "ArrowLeft")).toEqual({ kind: "move", index: 0 });
    expect(fileTreeKeyNavigation(tree, 4, "ArrowLeft")).toBeNull();
  });

  it("其他按键不处理", () => {
    expect(fileTreeKeyNavigation(tree, 0, "Enter")).toBeNull();
    expect(fileTreeKeyNavigation(tree, 0, "a")).toBeNull();
  });

  it("PageUp/PageDown 按页移动并在边界收窄", () => {
    const bigTree = Array.from({ length: 25 }, (_, index) => rows([`file-${index}.ts`, 0, false, "file"] as const)[0]);
    expect(fileTreeKeyNavigation(bigTree, 2, "PageDown")).toEqual({ kind: "move", index: 22 });
    expect(fileTreeKeyNavigation(bigTree, 22, "PageUp")).toEqual({ kind: "move", index: 2 });
    expect(fileTreeKeyNavigation(bigTree, 24, "PageDown")).toBeNull();
    expect(fileTreeKeyNavigation(bigTree, 0, "PageUp")).toBeNull();
  });
});

function nestedStickyRows(): FileTreeRow[] {
  return [
    ...rows(
      ["root", 0, true, "directory"],
      ["a", 1, true, "directory"],
      ["b", 2, true, "directory"],
      ["c", 3, true, "directory"],
    ),
    ...Array.from(
      { length: 12 },
      (_, index): FileTreeRow => ({
        kind: "node",
        path: `c/file-${index}.ts`,
        depth: 4,
        open: false,
        node: { name: `file-${index}.ts`, path: `c/file-${index}.ts`, type: "file" },
      }),
    ),
    ...rows(["tail.ts", 0, false, "file"]),
  ];
}

describe("file tree sticky scroll", () => {
  it("precomputes parent indices and expanded subtree ends", () => {
    const tree: FileTreeRow[] = [
      ...rows(["root", 0, true, "directory"], ["src", 1, true, "directory"], ["src/a.ts", 2, false, "file"]),
      { kind: "loading", path: "src/loading", depth: 2, open: false },
      ...rows(["root.ts", 1, false, "file"], ["tail.ts", 0, false, "file"]),
    ];

    expect(buildFileTreeStickyModel(tree)).toEqual({
      parentIndices: [null, 0, 1, 1, 0, null],
      endIndices: [4, 3, 2, 3, 4, 5],
    });
  });

  it("stacks visible ancestors beneath the sticky viewport edge", () => {
    const tree = nestedStickyRows();
    const sticky = fileTreeStickyRows(tree, buildFileTreeStickyModel(tree), 4 * 28, 280, 28);

    expect(sticky).toEqual([
      { index: 0, position: 0 },
      { index: 1, position: 28 },
      { index: 2, position: 56 },
      { index: 3, position: 84 },
    ]);
  });

  it("limits sticky rows to 40 percent of the viewport and the configured item count", () => {
    const tree = nestedStickyRows();
    const model = buildFileTreeStickyModel(tree);

    expect(fileTreeStickyRows(tree, model, 4 * 28, 140, 28)).toHaveLength(2);
    expect(fileTreeStickyRows(tree, model, 4 * 28, 280, 28, 2)).toHaveLength(2);
  });

  it("pushes the final sticky directory away at the end of its subtree", () => {
    const tree: FileTreeRow[] = [
      ...rows(["root", 0, true, "directory"], ["folder", 1, true, "directory"]),
      ...Array.from(
        { length: 4 },
        (_, index): FileTreeRow => ({
          kind: "node",
          path: `folder/file-${index}.ts`,
          depth: 2,
          open: false,
          node: { name: `file-${index}.ts`, path: `folder/file-${index}.ts`, type: "file" },
        }),
      ),
      ...rows(["other.ts", 1, false, "file"]),
    ];

    expect(fileTreeStickyRows(tree, buildFileTreeStickyModel(tree), 130, 280, 28)).toEqual([
      { index: 0, position: 0 },
      { index: 1, position: 10 },
    ]);
  });

  it("does not render sticky rows before scrolling", () => {
    const tree = nestedStickyRows();
    expect(fileTreeStickyRows(tree, buildFileTreeStickyModel(tree), 0, 280, 28)).toEqual([]);
  });
});
