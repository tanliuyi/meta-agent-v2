import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePreview } from "../src/renderer/src/components/panel/files/file-preview.tsx";
import type { TextFile } from "../src/shared/contracts.ts";

const panelCss = readFileSync(new URL("../src/renderer/src/styles/panel.css", import.meta.url), "utf8");
const highlightClientSource = readFileSync(
  new URL("../src/renderer/src/components/panel/files/file-highlight-client.ts", import.meta.url),
  "utf8",
);

const file: TextFile = {
  path: "src/index.ts",
  content: "const a = 1;\n\nconsole.log(a);\n",
  language: "typescript",
};

function render(props: Partial<React.ComponentProps<typeof FilePreview>> = {}): string {
  return renderToStaticMarkup(<FilePreview file={file} wrap={false} onScrollChange={() => {}} {...props} />);
}

describe("FilePreview", () => {
  it("渲染行号与文件内容", () => {
    const markup = render();
    expect(markup).toContain("const a = 1;");
    expect(markup).toContain("console.log(a);");
    // 4 行内容：1..4 行号
    expect(markup).toContain(">1</span>");
    expect(markup).toContain(">4</span>");
  });

  it("高亮结果按行渲染 token", () => {
    const tokens = file.content
      .split("\n")
      .map((line) => (line ? [{ content: line, offset: 0, color: "#D8DEE9" }] : []));
    const markup = render({
      highlight: { file, tokens: { tokens, fg: "#D8DEE9" } as never },
    });
    expect(markup).toContain("file-preview-token");
  });

  it("使用 Vite 可静态分析的 Worker 构造形式", () => {
    expect(highlightClientSource).toContain(
      'new Worker(new URL("./file-highlight.worker.ts", import.meta.url), { type: "module" })',
    );
  });

  it("大文件降级时显示提示", () => {
    const markup = render({ degraded: true });
    expect(markup).toContain("文件较大，已禁用语法高亮");
  });

  it("空行渲染占位空格", () => {
    const markup = render();
    expect(markup).toContain("> </span>");
  });

  it("横向滚动时固定行号列", () => {
    expect(panelCss).toMatch(/\.file-preview-body\s*>\s*pre\s*\{[^}]*--file-preview-content-width:\s*100%;/s);
    expect(panelCss).toMatch(/\.file-preview-row\s*\{[^}]*width:\s*var\(--file-preview-content-width, 100%\);/s);
    expect(panelCss).toMatch(/\.file-preview-line-number\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0;/s);
    expect(panelCss).not.toContain("--file-preview-scroll-left");
  });

  it("只显示活动文件预览内容", () => {
    expect(panelCss).toMatch(/\.file-preview-content\s*\{[^}]*display:\s*none;[^}]*\}/s);
    expect(panelCss).toMatch(/\.file-preview-content\[data-state="active"\]\s*\{[^}]*display:\s*block;[^}]*\}/s);
  });

  it("渲染代码缩略图容器", () => {
    const markup = render();
    expect(markup).toContain('class="file-minimap"');
    expect(markup).toContain("代码缩略图");
  });
});
