import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerContextUsage } from "../src/renderer/src/components/chat/composer/composer-context-usage.tsx";

describe("ComposerContextUsage", () => {
  it("没有 usage 数据时不渲染", () => {
    const markup = renderToStaticMarkup(createElement(ComposerContextUsage, { usage: undefined }));

    expect(markup).toBe("");
  });

  it("展示已用 tokens 与上下文窗口", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerContextUsage, {
        usage: { tokens: 42300, contextWindow: 200000, percent: 21.15 },
      }),
    );

    expect(markup).toContain("上下文使用量");
    expect(markup).toContain("21%");
    expect(markup).toContain("42k / 200k");
    expect(markup).not.toContain("text-destructive");
  });

  it("接近限制时红色警告", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerContextUsage, {
        usage: { tokens: 182000, contextWindow: 200000, percent: 91 },
      }),
    );

    expect(markup).toContain("91%");
    expect(markup).toContain("text-destructive");
  });

  it("压缩后 tokens 未知时显示未知状态", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerContextUsage, {
        usage: { tokens: null, contextWindow: 200000, percent: null },
      }),
    );

    expect(markup).toContain("?");
    expect(markup).toContain("未知");
    expect(markup).not.toContain("text-destructive");
  });
});
