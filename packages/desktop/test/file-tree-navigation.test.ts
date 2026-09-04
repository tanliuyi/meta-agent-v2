import { describe, expect, it } from "vitest";
import {
  buildFileTreeRows,
  buildFileTreeStickyModel,
  type FileTreeRow,
  fileTreeKeyNavigation,
  fileTreeRenderRange,
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

describe("buildFileTreeRows", () => {
  it("compresses consecutive single-directory branches into one row", () => {
    const roots = [{ name: "src", path: "src", type: "directory", hasChildren: true }] as const;
    const children = {
      src: [{ name: "extension", path: "src/extension", type: "directory", hasChildren: true }],
      "src/extension": [{ name: "commands", path: "src/extension/commands", type: "directory", hasChildren: true }],
      "src/extension/commands": [{ name: "index.ts", path: "src/extension/commands/index.ts", type: "file" }],
    } as const;

    const result = buildFileTreeRows(roots, children, new Set(["src", "src/extension", "src/extension/commands"]));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: "src/extension/commands", depth: 0, open: true });
    expect(result[0]?.compressedNodes?.map((node) => node.name)).toEqual(["src", "extension", "commands"]);
    expect(result[1]).toMatchObject({ path: "src/extension/commands/index.ts", depth: 1 });
  });

  it("keeps semantic roots separate while compacting descendant directory chains", () => {
    const roots = [{ name: "未跟踪", path: "group:untracked", type: "directory", hasChildren: true }] as const;
    const children = {
      "group:untracked": [{ name: "packages", path: "packages", type: "directory", hasChildren: true }],
      packages: [{ name: "desktop", path: "packages/desktop", type: "directory", hasChildren: true }],
      "packages/desktop": [{ name: "scripts", path: "packages/desktop/scripts", type: "directory", hasChildren: true }],
      "packages/desktop/scripts": [
        { name: "generate.mjs", path: "packages/desktop/scripts/generate.mjs", type: "file" },
      ],
    } as const;

    const result = buildFileTreeRows(
      roots,
      children,
      new Set(["group:untracked", "packages", "packages/desktop", "packages/desktop/scripts"]),
      0,
      false,
    );

    expect(result[0]).toMatchObject({ path: "group:untracked", depth: 0 });
    expect(result[0]?.compressedNodes).toBeUndefined();
    expect(result[1]?.compressedNodes?.map((node) => node.name)).toEqual(["packages", "desktop", "scripts"]);
    expect(result[2]).toMatchObject({ path: "packages/desktop/scripts/generate.mjs", depth: 2 });
  });

  it("stops compression at files, empty directories, unloaded directories, and branches", () => {
    const roots = [
      { name: "file-parent", path: "file-parent", type: "directory", hasChildren: true },
      { name: "empty", path: "empty", type: "directory", hasChildren: false },
      { name: "unloaded", path: "unloaded", type: "directory", hasChildren: true },
      { name: "branch", path: "branch", type: "directory", hasChildren: true },
    ] as const;
    const children = {
      "file-parent": [{ name: "index.ts", path: "file-parent/index.ts", type: "file" }],
      empty: [],
      branch: [
        { name: "a", path: "branch/a", type: "directory" },
        { name: "b", path: "branch/b", type: "directory" },
      ],
    } as const;

    const result = buildFileTreeRows(roots, children, new Set());

    expect(result.map((row) => row.path)).toEqual(["file-parent", "empty", "unloaded", "branch"]);
    expect(result.every((row) => row.compressedNodes === undefined)).toBe(true);
  });
});

describe("fileTreeRenderRange", () => {
  it("changes only after the visible range crosses a fixed-height row boundary", () => {
    const initial = fileTreeRenderRange(500, 280, 270, 28, 8);
    expect(fileTreeRenderRange(500, 290, 270, 28, 8)).toEqual(initial);
    expect(fileTreeRenderRange(500, 291, 270, 28, 8)).not.toEqual(initial);
  });

  it("clamps the range and preserves overscan at both ends", () => {
    expect(fileTreeRenderRange(100, 0, 280, 28, 8)).toEqual({ start: 0, end: 18 });
    expect(fileTreeRenderRange(100, 2_520, 280, 28, 8)).toEqual({ start: 82, end: 100 });
    expect(fileTreeRenderRange(0, 0, 280, 28, 8)).toEqual({ start: 0, end: 0 });
  });
});

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
