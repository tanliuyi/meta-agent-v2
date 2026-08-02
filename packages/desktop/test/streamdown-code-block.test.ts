import type { code as codeHighlighter, HighlightResult } from "@streamdown/code";
import { describe, expect, it, vi } from "vitest";
import {
  resolveHighlightedTokens,
  startHighlightRequest,
  streamingHighlightAction,
} from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-code-block.tsx";
import { resolveTokenStyle } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-code-line.tsx";

function highlighted(code: string, language = "ts"): { code: string; language: string; result: HighlightResult } {
  return {
    code,
    language,
    result: {
      tokens: code.split("\n").map((line, index) => [{ content: line, offset: index }]),
    } as HighlightResult,
  };
}

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
    const h = highlighted("const previous = true;");
    h.result = { tokens } as HighlightResult;

    expect(resolveHighlightedTokens(h, h.code, h.language)).toBe(tokens);
    expect(resolveHighlightedTokens(h, "const current = true;", h.language)).toBeUndefined();
    expect(resolveHighlightedTokens(h, h.code, "tsx")).toBeUndefined();
  });

  it("流式追加时保留已高亮前缀，尾部按纯文本补齐", () => {
    const h = highlighted("const a = 1;\nconst b = 2;");

    const merged = resolveHighlightedTokens(h, "const a = 1;\nconst b = 2;\nconst c = 3;", "ts");
    expect(merged).toEqual([
      [{ content: "const a = 1;", offset: 0 }],
      [{ content: "const b = 2;", offset: 1 }],
      [{ content: "const c = 3;", offset: 0 }],
    ]);
    // 原高亮结果不被合并逻辑污染，后续渲染仍能复用
    expect(h.result.tokens).toHaveLength(2);
    expect(resolveHighlightedTokens(h, h.code, h.language)).toBe(h.result.tokens);
  });

  it("流式追加发生在行中间时续接最后一个 token", () => {
    const h = highlighted("const a = 1");

    const merged = resolveHighlightedTokens(h, "const a = 1;", "ts");
    expect(merged).toEqual([
      [
        { content: "const a = 1", offset: 0 },
        { content: ";", offset: 11 },
      ],
    ]);
  });

  it("流式追加以换行开始时将尾部作为新行", () => {
    const h = highlighted("const a = 1;");

    const merged = resolveHighlightedTokens(h, "const a = 1;\n", "ts");
    expect(merged).toEqual([[{ content: "const a = 1;", offset: 0 }], [{ content: "", offset: 0 }]]);
  });

  it("流式追加到以换行结尾的前缀时复用尾部空行", () => {
    const h = highlighted("const a = 1;\n");

    const merged = resolveHighlightedTokens(h, "const a = 1;\nconst b = 2;", "ts");
    expect(merged).toEqual([[{ content: "const a = 1;", offset: 0 }], [{ content: "const b = 2;", offset: 0 }]]);
  });

  it("异步高亮加载期间保留现有结果，并忽略取消后的回调", () => {
    let complete: ((result: HighlightResult) => void) | undefined;
    const applyResult = vi.fn();
    const options = {
      code: "const a = 1;",
      language: "ts",
      themes: ["github-light", "github-dark"],
    } as Parameters<typeof codeHighlighter.highlight>[0];
    const cancel = startHighlightRequest(
      (_options, callback) => {
        complete = callback;
        return null;
      },
      options,
      applyResult,
    );

    expect(applyResult).not.toHaveBeenCalled();
    cancel();
    complete?.({ tokens: [[{ content: "const a = 1;", offset: 0 }]] } as HighlightResult);
    expect(applyResult).not.toHaveBeenCalled();
  });

  it("首次渲染立即高亮", () => {
    expect(streamingHighlightAction(undefined, "const a = 1;", "ts", 10)).toEqual({ kind: "highlight" });
  });

  it("内容被替换（非追加）时立即重新高亮", () => {
    const h = highlighted("const a = 1;");
    expect(streamingHighlightAction(h, "const b = 2;", "ts", 10)).toEqual({ kind: "highlight" });
  });

  it("高亮已与当前代码一致时不再调度", () => {
    const h = highlighted("const a = 1;");
    expect(streamingHighlightAction(h, h.code, "ts", 10)).toEqual({ kind: "none" });
    expect(streamingHighlightAction(h, h.code, "js", 10)).toEqual({ kind: "highlight" });
  });

  it("流式尾部不足一批完整行时等待流停止", () => {
    const h = highlighted("const a = 1;");
    expect(streamingHighlightAction(h, "const a = 1;\nconst b = 2;", "ts", 10)).toEqual({ kind: "settle" });
  });

  it("流式追加达到一批完整行时批量高亮", () => {
    const h = highlighted("const a = 1;");
    const tail = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join("\n");
    expect(streamingHighlightAction(h, `${h.code}\n${tail}`, "ts", 10)).toEqual({ kind: "highlight" });
    // 未完成的行不计数
    expect(streamingHighlightAction(h, `${h.code}\n${tail}\nconst partial`, "ts", 10)).toEqual({
      kind: "highlight",
    });
    const nineLines = tail.split("\n").slice(0, 9).join("\n");
    expect(streamingHighlightAction(h, `${h.code}\n${nineLines}`, "ts", 10)).toEqual({ kind: "settle" });
  });
});
