import { describe, expect, it } from "vitest";
import {
  activeFileChange,
  emptyFileTreeData,
  removeLoadedFileTreeDirectory,
  replaceFileTreeDirectory,
} from "../src/renderer/src/components/panel/files/file-tree-data.ts";
import type { FileNode } from "../src/shared/contracts.ts";

const rootFile: FileNode = { name: "README.md", path: "README.md", type: "file" };
const childFile: FileNode = { name: "index.ts", path: "src/index.ts", type: "file" };

describe("file tree data", () => {
  it("根目录监听刷新替换 roots，而不是写入 children 空路径", () => {
    const initial = replaceFileTreeDirectory(emptyFileTreeData(), "src", [childFile]);
    const next = replaceFileTreeDirectory(initial, "", [rootFile]);

    expect(next.roots).toEqual([rootFile]);
    expect(next.children).toEqual({ src: [childFile] });
    expect(next.children[""]).toBeUndefined();
  });

  it("子目录刷新只替换对应 children 缓存", () => {
    const initial = replaceFileTreeDirectory(emptyFileTreeData(), "", [rootFile]);
    const next = replaceFileTreeDirectory(initial, "src", [childFile]);

    expect(next.roots).toEqual([rootFile]);
    expect(next.children).toEqual({ src: [childFile] });
  });

  it("活动文件更新、重建和祖先目录删除会触发正确动作", () => {
    const base = { projectId: "project", added: [], deleted: [], updated: [] };
    expect(activeFileChange({ ...base, updated: ["src/index.ts"] }, "src/index.ts")).toBe("reload");
    expect(activeFileChange({ ...base, added: ["src/index.ts"] }, "src/index.ts")).toBe("reload");
    expect(activeFileChange({ ...base, deleted: ["src"] }, "src/index.ts")).toBe("deleted");
    expect(activeFileChange({ ...base, updated: ["src/other.ts"] }, "src/index.ts")).toBeNull();
  });

  it("删除已加载目录时清理对应缓存", () => {
    const initial = replaceFileTreeDirectory(emptyFileTreeData(), "src", [childFile]);
    expect(removeLoadedFileTreeDirectory(initial, "src")).toEqual({ roots: [], children: {} });
    expect(removeLoadedFileTreeDirectory(initial, "missing")).toBe(initial);
  });
});
