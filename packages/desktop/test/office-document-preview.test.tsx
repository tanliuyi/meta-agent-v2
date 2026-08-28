import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocxPlanDiff } from "../src/renderer/src/components/panel/files/docx-plan-diff.tsx";
import { secureOfficeDocumentHtml } from "../src/renderer/src/components/panel/files/legacy-office-document-preview.tsx";
import { OfficeDocumentPreview } from "../src/renderer/src/components/panel/files/office-document-preview.tsx";

describe("OfficeDocumentPreview", () => {
  it("把不可信 OfficeCLI HTML 编码进 CSP 之后的无权限内层 iframe", () => {
    const secured = secureOfficeDocumentHtml(
      '<!-- <head> --><img src="https://example.com/tracker.png"><script>alert(1)</script>',
    );

    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(secured.indexOf("tracker.png"));
    expect(secured).toContain("default-src 'none'");
    expect(secured).toContain("img-src data: blob:");
    expect(secured).toContain("form-action 'none'");
    expect(secured).toContain('sandbox=""');
    expect(secured).toContain("&lt;!-- &lt;head&gt; --&gt;");
    expect(secured).not.toContain("allow-scripts");
  });

  it("始终生成单一可信外层文档，不把原始 head 提升到 CSP 前", () => {
    const secured = secureOfficeDocumentHtml(
      '<!doctype html><html lang="en"><head><style>body{color:red}</style></head><body>report</body></html>',
    );

    expect(secured.match(/<html/giu)).toHaveLength(1);
    expect(secured.match(/<head/giu)).toHaveLength(1);
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(secured.indexOf("&lt;style&gt;"));
    expect(secured).toContain("&lt;html lang=&quot;en&quot;&gt;");
  });

  it("使用无权限 sandbox iframe 渲染旧格式", () => {
    const markup = renderToStaticMarkup(
      <OfficeDocumentPreview
        preview={{
          kind: "legacy-html",
          format: "pptx",
          path: "reports/slides.pptx",
          html: "<main>report</main>",
        }}
      />,
    );

    expect(markup).toContain('class="file-preview-office"');
    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain("slides.pptx 文档预览");
  });

  it("原生渲染 XLSX worksheet grid 和 sheet tabs", () => {
    const markup = renderToStaticMarkup(
      <OfficeDocumentPreview
        preview={{
          kind: "xlsx",
          format: "xlsx",
          path: "reports/budget.xlsx",
          documentId: "xlsx-1",
          revision: 1,
          sheets: [
            {
              id: "sheet:rId1",
              name: "Budget",
              rowCount: 1,
              columnCount: 2,
              cellCount: 2,
              truncated: false,
              cells: [
                {
                  id: "rId1:A1",
                  address: "A1",
                  value: "Revenue",
                  valueSha256: "hash",
                  valueType: "string",
                  editable: true,
                },
                {
                  id: "rId1:B1",
                  address: "B1",
                  value: "42",
                  valueSha256: "hash",
                  valueType: "number",
                  editable: false,
                  blockedReason: "formula",
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("Budget");
    expect(markup).toContain('role="grid"');
    expect(markup).toContain("Revenue");
    expect(markup).toContain('title="formula"');
    expect(markup).not.toContain("<iframe");
  });

  it("展示单元格精确差异", () => {
    const markup = renderToStaticMarkup(
      <DocxPlanDiff
        plan={{
          planId: "plan-cell",
          documentId: "xlsx-1",
          baseRevision: 1,
          resultingRevision: 2,
          semanticDiff: [
            {
              type: "cell-value",
              sheetId: "sheet:rId1",
              cellId: "rId1:A1",
              address: "A1",
              before: "Old",
              after: "New",
            },
          ],
          touchedRuns: [],
          touchedParagraphs: [],
          touchedCells: ["rId1:A1"],
          touchedParts: ["xl/worksheets/sheet1.xml"],
          warnings: [],
          expiresAt: 10_000,
          planSha256: "plan-hash",
        }}
      />,
    );
    expect(markup).toContain("修改单元格 A1");
    expect(markup).toContain("<del>Old</del><ins>New</ins>");
  });

  it("展示跨运行计划中每个受影响运行的精确差异", () => {
    const markup = renderToStaticMarkup(
      <DocxPlanDiff
        plan={{
          planId: "plan-range",
          documentId: "document-1",
          baseRevision: 3,
          resultingRevision: 4,
          semanticDiff: [
            { runId: "run-1", before: "One", after: "O&" },
            { runId: "run-2", before: "Two", after: "o" },
          ],
          touchedRuns: ["run-1", "run-2"],
          touchedParagraphs: [],
          touchedParts: ["word/document.xml"],
          warnings: [],
          expiresAt: 10_000,
          planSha256: "plan-hash",
        }}
      />,
    );

    expect(markup).toContain("<del>One</del><ins>O&amp;</ins>");
    expect(markup).toContain("<del>Two</del><ins>o</ins>");
  });

  it("展示段落插入和删除的精确差异", () => {
    const markup = renderToStaticMarkup(
      <DocxPlanDiff
        plan={{
          planId: "plan-paragraph",
          documentId: "document-1",
          baseRevision: 3,
          resultingRevision: 4,
          semanticDiff: [
            { type: "paragraph", paragraphId: "p-1", change: "insert", before: "", after: "新增段落" },
            { type: "paragraph", paragraphId: "p-2", change: "delete", before: "删除段落", after: "" },
          ],
          touchedRuns: [],
          touchedParagraphs: ["p-1", "p-2"],
          touchedParts: ["word/document.xml"],
          warnings: [],
          expiresAt: 10_000,
          planSha256: "plan-hash",
        }}
      />,
    );

    expect(markup).toContain("插入段落");
    expect(markup).toContain("<ins>新增段落</ins>");
    expect(markup).toContain("删除段落");
    expect(markup).toContain("<del>删除段落</del>");
  });

  it("直接渲染 DOCX 结构化段落并区分可编辑和阻断运行", () => {
    const markup = renderToStaticMarkup(
      <OfficeDocumentPreview
        preview={{
          kind: "docx",
          format: "docx",
          path: "reports/quarterly.docx",
          renderTree: {
            documentId: "document-1",
            revision: 3,
            format: "docx",
            root: {
              type: "document",
              relatedParts: [
                {
                  id: "footer:rFooter",
                  kind: "footer",
                  blocked: false,
                  paragraphs: [
                    {
                      type: "paragraph",
                      part: "footer",
                      relatedPartId: "footer:rFooter",
                      id: "footer-paragraph",
                      editable: true,
                      textSha256: "footer-paragraph-hash",
                      runs: [
                        {
                          type: "text-run",
                          id: "footer-run",
                          text: "Footer text",
                          textSha256: "footer-hash",
                          editable: true,
                          properties: {},
                        },
                      ],
                    },
                  ],
                },
              ],
              comments: [
                {
                  id: "comment:rComments:0",
                  author: "Reviewer",
                  blocked: false,
                  paragraphs: [
                    {
                      type: "paragraph",
                      part: "comments",
                      commentId: "comment:rComments:0",
                      commentAuthor: "Reviewer",
                      id: "comment-paragraph",
                      editable: true,
                      textSha256: "comment-paragraph-hash",
                      runs: [
                        {
                          type: "text-run",
                          id: "comment-run",
                          text: "Comment text",
                          textSha256: "comment-hash",
                          editable: true,
                          properties: {},
                        },
                      ],
                    },
                  ],
                },
              ],
              children: [
                {
                  type: "paragraph",
                  part: "document",
                  id: "paragraph-1",
                  editable: false,
                  textSha256: "paragraph-hash",
                  runs: [
                    {
                      type: "text-run",
                      id: "run-1",
                      text: "Editable",
                      textSha256: "editable-hash",
                      editable: true,
                      properties: { bold: true, italic: false },
                    },
                    {
                      type: "text-run",
                      id: "run-2",
                      text: "Blocked",
                      textSha256: "blocked-hash",
                      editable: false,
                      blockedReason: "hyperlink-boundary",
                      properties: { bold: false, italic: true },
                    },
                  ],
                },
              ],
            },
            warnings: [{ code: "unsupported-content", part: "word/document.xml", message: "部分内容只读" }],
          },
        }}
      />,
    );

    expect(markup).toContain('class="docx-page"');
    expect(markup).toContain("Editable");
    expect(markup).toContain("Blocked");
    expect(markup).toContain('title="编辑文本"');
    expect(markup).toContain('title="hyperlink-boundary"');
    expect(markup).toContain("Footer text");
    expect(markup).toContain('aria-label="页脚"');
    expect(markup).toContain('aria-label="批注"');
    expect(markup).toContain("Reviewer");
    expect(markup).toContain("Comment text");
    expect(markup).toContain("部分内容只读");
    expect(markup).not.toContain("<iframe");
  });
});
