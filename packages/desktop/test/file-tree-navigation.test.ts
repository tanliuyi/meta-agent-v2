import { describe, expect, it } from "vitest";
import {
  type FileTreeRow,
  fileTreeKeyNavigation,
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
