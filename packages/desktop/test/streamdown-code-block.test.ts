import type { HighlightResult } from "@streamdown/code";
import { describe, expect, it } from "vitest";
import {
  resolveHighlightedTokens,
  resolveTokenStyle,
} from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-code-block.tsx";

describe("Streamdown code block", () => {
  it("将 Shiki 浅色内联颜色转换为可被暗色主题覆盖的 CSS 变量", () => {
    const style = resolveTokenStyle({
      content: "const",
      offset: 0,
      htmlStyle: {
        color: "#D73A49",
        backgroundColor: "#ffffff",
        "--shiki-dark": "#F97583",
        "--shiki-dark-bg": "#0d1117",
      },
    });

    expect(style).toEqual({
      "--markdown-code-token-color": "#D73A49",
      "--markdown-code-token-background": "#ffffff",
      "--shiki-dark": "#F97583",
      "--shiki-dark-bg": "#0d1117",
    });
    expect(style).not.toHaveProperty("color");
    expect(style).not.toHaveProperty("backgroundColor");
  });

  it("仅使用与当前代码和语言匹配的高亮结果", () => {
    const tokens: HighlightResult["tokens"] = [[{ content: "const previous = true;", offset: 0 }]];
    const highlighted = {
      code: "const previous = true;",
      language: "ts",
      result: { tokens } as HighlightResult,
    };

    expect(resolveHighlightedTokens(highlighted, highlighted.code, highlighted.language)).toBe(tokens);
    expect(resolveHighlightedTokens(highlighted, "const current = true;", highlighted.language)).toBeUndefined();
    expect(resolveHighlightedTokens(highlighted, highlighted.code, "tsx")).toBeUndefined();
  });
});
