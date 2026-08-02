import { describe, expect, it } from "vitest";
import {
  buildQuotePrefix,
  parseQuoteAttachmentData,
  quoteToBlockquote,
  stripQuotePrefix,
  withQuoteContext,
} from "../src/main/pi/quote-context.ts";

describe("quote-context", () => {
  it("单条引用转块引用并统一换行", () => {
    expect(quoteToBlockquote({ text: "第一行\n第二行" })).toBe("> 第一行\n> 第二行");
    expect(quoteToBlockquote({ text: "第一行\r\n第二行" })).toBe("> 第一行\n> 第二行");
  });

  it("withQuoteContext 构造的文本能被 buildQuotePrefix 精确剥离（round-trip）", () => {
    const quotes = [
      { text: "第一行\n第二行", messageId: "assistant-1" },
      { text: "第三段", messageId: "assistant-2" },
    ];
    const text = "解释这段话";
    const prefixed = withQuoteContext(text, quotes);
    expect(prefixed).toBe("> 第一行\n> 第二行\n\n> 第三段\n\n解释这段话");
    expect(prefixed.startsWith(buildQuotePrefix(quotes))).toBe(true);
    expect(stripQuotePrefix(prefixed, quotes)).toBe(text);
  });

  it("无引用时 withQuoteContext/stripQuotePrefix 原样返回", () => {
    expect(withQuoteContext("text", [])).toBe("text");
    expect(stripQuotePrefix("text", [])).toBe("text");
  });

  it("前缀不匹配时 stripQuotePrefix 不猜测引用边界", () => {
    const quotes = [{ text: "引用内容", messageId: "assistant" }];
    // 用户自己输入了 > 开头的内容（无引用语义），绝不能误剥
    expect(stripQuotePrefix("> 用户自己输入", quotes)).toBe("> 用户自己输入");
    // 扩展改写导致前缀不完整（引用内追加了行），不剥离
    expect(stripQuotePrefix("> 引用内容\n> 追加行\n\n改写后", quotes)).toBe("> 引用内容\n> 追加行\n\n改写后");
  });

  it("parseQuoteAttachmentData 校验结构并拒绝非法数据", () => {
    expect(
      parseQuoteAttachmentData({
        userEntryId: "user-1",
        requestId: "request",
        quotes: [{ text: "引用", messageId: "assistant" }],
      }),
    ).toEqual({ userEntryId: "user-1", requestId: "request", quotes: [{ text: "引用", messageId: "assistant" }] });

    expect(parseQuoteAttachmentData(undefined)).toBeUndefined();
    expect(parseQuoteAttachmentData(null)).toBeUndefined();
    expect(parseQuoteAttachmentData({ userEntryId: 1, requestId: "request", quotes: [] })).toBeUndefined();
    expect(
      parseQuoteAttachmentData({
        userEntryId: "user-1",
        requestId: "request",
        quotes: [{ text: " ", messageId: "assistant" }],
      }),
    ).toBeUndefined();
  });
});
