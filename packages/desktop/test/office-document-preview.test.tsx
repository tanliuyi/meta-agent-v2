import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OfficeDocumentPreview,
  secureOfficeDocumentHtml,
} from "../src/renderer/src/components/panel/files/office-document-preview.tsx";

describe("OfficeDocumentPreview", () => {
  it("在原始 OfficeCLI HTML 前注入阻断脚本和网络的 CSP", () => {
    const secured = secureOfficeDocumentHtml('<img src="https://example.com/tracker.png"><script>alert(1)</script>');

    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(secured.indexOf("tracker.png"));
    expect(secured).toContain("default-src 'none'");
    expect(secured).toContain("img-src data: blob:");
    expect(secured).toContain("form-action 'none'");
    expect(secured).not.toContain("allow-scripts");
  });

  it("把 CSP 注入完整 HTML 的现有 head，不产生嵌套文档", () => {
    const secured = secureOfficeDocumentHtml(
      '<!doctype html><html lang="en"><head><style>body{color:red}</style></head><body>report</body></html>',
    );

    expect(secured.match(/<html/giu)).toHaveLength(1);
    expect(secured.match(/<head/giu)).toHaveLength(1);
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(secured.indexOf("<style>"));
    expect(secured).toContain('<html lang="en">');
  });

  it("使用无权限 sandbox iframe 渲染", () => {
    const markup = renderToStaticMarkup(
      <OfficeDocumentPreview preview={{ path: "reports/quarterly.docx", html: "<main>report</main>" }} />,
    );

    expect(markup).toContain('class="file-preview-office"');
    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain("quarterly.docx 文档预览");
  });
});
