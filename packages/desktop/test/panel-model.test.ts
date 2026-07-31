import { describe, expect, it } from "vitest";
import {
  closeWorkbenchFile,
  filePathSegments,
  replaceActiveWorkbenchFile,
} from "../src/renderer/src/components/panel/panel-model.ts";

describe("closeWorkbenchFile", () => {
  const openFiles = ["a.ts", "b.ts", "c.ts"];

  it("关闭活动文件后优先选择右侧文件", () => {
    expect(closeWorkbenchFile(openFiles, "b.ts", "b.ts")).toEqual({
      openFiles: ["a.ts", "c.ts"],
      activeFile: "c.ts",
    });
  });

  it("关闭末尾活动文件后选择左侧文件", () => {
    expect(closeWorkbenchFile(openFiles, "c.ts", "c.ts")).toEqual({
      openFiles: ["a.ts", "b.ts"],
      activeFile: "b.ts",
    });
  });

  it("关闭非活动文件时保留当前文件", () => {
    expect(closeWorkbenchFile(openFiles, "a.ts", "c.ts")).toEqual({
      openFiles: ["a.ts", "b.ts"],
      activeFile: "a.ts",
    });
  });

  it("关闭最后一个文件后清空活动文件", () => {
    expect(closeWorkbenchFile(["a.ts"], "a.ts", "a.ts")).toEqual({
      openFiles: [],
      activeFile: undefined,
    });
  });

  it("忽略未打开的文件", () => {
    expect(closeWorkbenchFile(openFiles, "a.ts", "missing.ts")).toBeNull();
  });
});

describe("filePathSegments", () => {
  it("生成可用于目录弹层的累计路径", () => {
    expect(filePathSegments("packages/desktop/src/index.ts")).toEqual([
      { label: "packages", path: "packages", directory: true },
      { label: "desktop", path: "packages/desktop", directory: true },
      { label: "src", path: "packages/desktop/src", directory: true },
      { label: "index.ts", path: "packages/desktop/src/index.ts", directory: false },
    ]);
  });
});

describe("replaceActiveWorkbenchFile", () => {
  it("在当前活动 tab 中替换文件", () => {
    expect(replaceActiveWorkbenchFile(["a.ts", "b.ts"], "a.ts", "c.ts")).toEqual({
      openFiles: ["c.ts", "b.ts"],
      activeFile: "c.ts",
    });
  });

  it("目标已打开时移除当前 tab 并切换到目标文件", () => {
    expect(replaceActiveWorkbenchFile(["a.ts", "b.ts"], "a.ts", "b.ts")).toEqual({
      openFiles: ["b.ts"],
      activeFile: "b.ts",
    });
  });
});
