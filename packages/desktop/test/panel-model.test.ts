import { describe, expect, it } from "vitest";
import {
  closeWorkbenchFile,
  filePathSegments,
  isImagePath,
  isOfficeDocumentPath,
  isPdfPath,
  openWorkbenchFileAsPreview,
  openWorkbenchFilePatch,
  pinWorkbenchFile,
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

describe("openWorkbenchFileAsPreview", () => {
  it("无预览 tab 时追加为新预览 tab", () => {
    expect(openWorkbenchFileAsPreview(["a.ts"], undefined, "b.ts")).toEqual({
      openFiles: ["a.ts", "b.ts"],
      activeFile: "b.ts",
      previewFile: "b.ts",
    });
  });

  it("有预览 tab 时原地替换（VS Code 预览行为）", () => {
    expect(openWorkbenchFileAsPreview(["a.ts", "b.ts"], "b.ts", "c.ts")).toEqual({
      openFiles: ["a.ts", "c.ts"],
      activeFile: "c.ts",
      previewFile: "c.ts",
    });
  });

  it("再次点击同一预览 tab 只切换激活", () => {
    expect(openWorkbenchFileAsPreview(["a.ts", "b.ts"], "b.ts", "b.ts")).toEqual({
      openFiles: ["a.ts", "b.ts"],
      activeFile: "b.ts",
      previewFile: "b.ts",
    });
  });

  it("预览 tab 已固定（无 previewFile）时按普通 tab 追加", () => {
    expect(openWorkbenchFileAsPreview(["a.ts", "b.ts"], undefined, "c.ts")).toEqual({
      openFiles: ["a.ts", "b.ts", "c.ts"],
      activeFile: "c.ts",
      previewFile: "c.ts",
    });
  });

  it("预览路径失效（不在 openFiles）时仍能打开目标", () => {
    expect(openWorkbenchFileAsPreview(["a.ts"], "ghost.ts", "c.ts")).toEqual({
      openFiles: ["a.ts", "c.ts"],
      activeFile: "c.ts",
      previewFile: "c.ts",
    });
  });
});

describe("pinWorkbenchFile", () => {
  it("固定当前预览 tab", () => {
    expect(pinWorkbenchFile("b.ts", "b.ts")).toEqual({ previewFile: undefined });
  });

  it("非预览目标不操作", () => {
    expect(pinWorkbenchFile("b.ts", "c.ts")).toBeNull();
    expect(pinWorkbenchFile(undefined, "b.ts")).toBeNull();
  });
});

describe("isImagePath", () => {
  it("识别常见图片扩展名（不区分大小写）", () => {
    expect(isImagePath("docs/logo.PNG")).toBe(true);
    expect(isImagePath("docs/photo.jpg")).toBe(true);
    expect(isImagePath("assets/icon.svg")).toBe(true);
    expect(isImagePath("assets/banner.webp")).toBe(true);
  });

  it("非图片路径返回 false", () => {
    expect(isImagePath("src/index.ts")).toBe(false);
    expect(isImagePath("README.md")).toBe(false);
    expect(isImagePath("no-extension")).toBe(false);
  });
});

describe("isOfficeDocumentPath", () => {
  it("识别 OfficeCLI 支持的 OOXML 文档", () => {
    expect(isOfficeDocumentPath("docs/report.DOCX")).toBe(true);
    expect(isOfficeDocumentPath("sheets/budget.xlsx")).toBe(true);
    expect(isOfficeDocumentPath("slides/demo.pptx")).toBe(true);
  });

  it("拒绝旧版 Office 和无关格式", () => {
    expect(isOfficeDocumentPath("legacy.doc")).toBe(false);
    expect(isOfficeDocumentPath("legacy.xls")).toBe(false);
    expect(isOfficeDocumentPath("document.pdf")).toBe(false);
  });
});

describe("isPdfPath", () => {
  it("仅识别 PDF 扩展名（不区分大小写）", () => {
    expect(isPdfPath("docs/report.pdf")).toBe(true);
    expect(isPdfPath("docs/report.PDF")).toBe(true);
    expect(isPdfPath("docs/report.pdf.txt")).toBe(false);
    expect(isPdfPath("docs/report")).toBe(false);
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

describe("openWorkbenchFilePatch", () => {
  const baseWorkbench = {
    openFiles: [],
    previewFile: undefined,
    expandedPaths: [],
  };

  it("打开文件为预览 tab 并展开全部父目录", () => {
    expect(openWorkbenchFilePatch(baseWorkbench, "packages/desktop/src/index.ts")).toEqual({
      openFiles: ["packages/desktop/src/index.ts"],
      activeFile: "packages/desktop/src/index.ts",
      previewFile: "packages/desktop/src/index.ts",
      expandedPaths: ["packages", "packages/desktop", "packages/desktop/src"],
    });
  });

  it("已展开的父目录不重复追加", () => {
    const workbench = { ...baseWorkbench, expandedPaths: ["packages", "packages/desktop"] };
    expect(openWorkbenchFilePatch(workbench, "packages/desktop/src/index.ts").expandedPaths).toEqual([
      "packages",
      "packages/desktop",
      "packages/desktop/src",
    ]);
  });

  it("根目录文件无需展开目录", () => {
    const patch = openWorkbenchFilePatch(baseWorkbench, "README.md");
    expect(patch.expandedPaths).toBeUndefined();
    expect(patch).toEqual({
      openFiles: ["README.md"],
      activeFile: "README.md",
      previewFile: "README.md",
    });
  });

  it("已有预览 tab 时原地替换；已展开目录不重复追加", () => {
    const workbench = {
      openFiles: ["a.ts"],
      previewFile: "a.ts",
      expandedPaths: ["src"],
    };
    expect(openWorkbenchFilePatch(workbench, "src/b.ts")).toEqual({
      openFiles: ["src/b.ts"],
      activeFile: "src/b.ts",
      previewFile: "src/b.ts",
    });
  });
});
