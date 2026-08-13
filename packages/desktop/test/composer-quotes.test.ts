import type { QuoteInfo } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  appendComposerQuote,
  getComposerQuotes,
  getMessageQuotes,
  removeComposerQuote,
  removeComposerQuoteByMessageId,
  toComposerQuote,
  updateComposerQuoteText,
} from "../src/renderer/src/runtime/composer-quotes.ts";
import type { PiQuote } from "../src/shared/contracts.ts";

const first: PiQuote = { text: "第一段", messageId: "assistant-1" };
const second: PiQuote = { text: "第二段", messageId: "assistant-2" };
const annotated: PiQuote = {
  text: "用户标注",
  messageId: "browser-annotation-1",
  tags: ["浏览器标注", "元素 div", "链接 https://example.com"],
};

describe("composer quotes", () => {
  it("keeps a single quote compatible with assistant-ui's existing carrier", () => {
    const value = toComposerQuote([first]);

    expect(value).toEqual(first);
    expect(getComposerQuotes(value)).toEqual([first]);
  });

  it("保留浏览器标注的标签元数据", () => {
    const value = toComposerQuote([annotated]);

    expect(value).toEqual(annotated);
    expect(getComposerQuotes(value)).toEqual([annotated]);
  });

  it("carries and removes multiple quotes independently", () => {
    let quote: QuoteInfo | undefined;
    const target = {
      getState: () => ({ quote }),
      setQuote: (next: QuoteInfo | undefined) => {
        quote = next;
      },
    };

    appendComposerQuote(target, first);
    appendComposerQuote(target, second);
    appendComposerQuote(target, first);

    expect(getComposerQuotes(quote)).toEqual([first, second]);
    removeComposerQuote(target, 0);
    expect(getComposerQuotes(quote)).toEqual([second]);
    removeComposerQuote(target, 4);
    expect(getComposerQuotes(quote)).toEqual([second]);
  });

  it("reads both new arrays and legacy single quote metadata", () => {
    expect(getMessageQuotes({ quotes: [first, second] })).toEqual([first, second]);
    expect(getMessageQuotes({ quote: first })).toEqual([first]);
    expect(getMessageQuotes({ quote: { ...first, quotes: [first, second] } })).toEqual([first, second]);
  });

  it("按 messageId 原位更新引用文本（保持位置与其他字段）", () => {
    let quote: QuoteInfo | undefined;
    const target = {
      getState: () => ({ quote }),
      setQuote: (next: QuoteInfo | undefined) => {
        quote = next;
      },
    };

    appendComposerQuote(target, first);
    appendComposerQuote(target, second);
    updateComposerQuoteText(target, "assistant-2", "第二段（已改）");
    expect(getComposerQuotes(quote)).toEqual([first, { ...second, text: "第二段（已改）" }]);
    // 不存在的 messageId 静默。
    updateComposerQuoteText(target, "missing", "x");
    expect(getComposerQuotes(quote)).toEqual([first, { ...second, text: "第二段（已改）" }]);
  });

  it("按 messageId 移除引用；不存在时静默", () => {
    let quote: QuoteInfo | undefined;
    const target = {
      getState: () => ({ quote }),
      setQuote: (next: QuoteInfo | undefined) => {
        quote = next;
      },
    };

    appendComposerQuote(target, first);
    appendComposerQuote(target, second);
    removeComposerQuoteByMessageId(target, "assistant-1");
    expect(getComposerQuotes(quote)).toEqual([second]);
    removeComposerQuoteByMessageId(target, "missing");
    expect(getComposerQuotes(quote)).toEqual([second]);
  });
});
