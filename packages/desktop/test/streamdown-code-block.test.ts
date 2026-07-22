import type { HighlightResult } from "@streamdown/code";
import { describe, expect, it } from "vitest";
import { resolveHighlightedTokens } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-code-block.tsx";

describe("Streamdown code block", () => {
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
