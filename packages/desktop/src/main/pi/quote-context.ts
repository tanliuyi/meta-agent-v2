import type { PiQuote } from "../../shared/contracts.ts";

/**
 * 引用附件的 session custom entry 类型。
 *
 * 结构化引用不会随 user message 文本持久化（Pi 只存文本），因此 user entry 落盘后
 * 由 Desktop 追加一条 custom entry（custom 类型默认不进 LLM 上下文）保存原始引用，
 * 供会话重建时恢复 chip。关联键是 user entry id，见 PiQuoteAttachmentData。
 */
export const QUOTE_ATTACHMENT_CUSTOM_TYPE = "desktop-quote-attachment";

export interface PiQuoteAttachmentData {
  /** 被引用 user entry 的 id，rebuild 时据此把引用挂回 user node。 */
  userEntryId: string;
  requestId: string;
  quotes: PiQuote[];
}

/** 单条引用转 Markdown 块引用：标签与文本分层，换行统一为 \n 并以 "> " 续行。 */
export function quoteToBlockquote(quote: Pick<PiQuote, "text" | "tags">): string {
  const tags = normalizeQuoteTags(quote.tags) ?? [];
  const tagLine = tags.length > 0 ? `> ${tags.map((tag) => `[${tag}]`).join(" ")}\n` : "";
  const text = quote.text.replace(/\r\n?/gu, "\n").replace(/\n/gu, "\n> ");
  return `${tagLine}> ${text}`;
}

/** 引用上下文前缀（各块引用间空行分隔，尾部带空行），与 withQuoteContext 构造的文本严格一致。 */
export function buildQuotePrefix(quotes: readonly PiQuote[]): string {
  return `${quotes.map(quoteToBlockquote).join("\n\n")}\n\n`;
}

/** 将结构化引用注入为 prompt 文本前的 Markdown 块引用。 */
export function withQuoteContext(text: string, quotes: readonly PiQuote[]): string {
  if (quotes.length === 0) return text;
  return `${buildQuotePrefix(quotes)}${text}`;
}

/**
 * 精确剥离我们自己构造的块引用前缀（仅当文本确实以该前缀开头时）。
 * 不匹配时原样返回——绝不解析用户输入猜测引用边界，避免误判。
 */
export function stripQuotePrefix(text: string, quotes: readonly PiQuote[]): string {
  if (quotes.length === 0) return text;
  const prefix = buildQuotePrefix(quotes);
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** 校验 session custom entry 中的引用附件数据，非法数据返回 undefined（降级为无 chip）。 */
export function parseQuoteAttachmentData(data: unknown): PiQuoteAttachmentData | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.userEntryId !== "string" || typeof record.requestId !== "string") return undefined;
  if (!Array.isArray(record.quotes)) return undefined;
  const quotes: PiQuote[] = [];
  for (const item of record.quotes) {
    if (typeof item !== "object" || item === null) return undefined;
    const quote = item as Record<string, unknown>;
    if (typeof quote.text !== "string" || typeof quote.messageId !== "string") return undefined;
    const text = quote.text.trim();
    const messageId = quote.messageId.trim();
    if (!text || !messageId) return undefined;
    const tags = normalizeQuoteTags(quote.tags);
    quotes.push({ text, messageId, ...(tags ? { tags } : {}) });
  }
  if (quotes.length === 0) return undefined;
  return { userEntryId: record.userEntryId, requestId: record.requestId, quotes };
}

function normalizeQuoteTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.replace(/[\r\n]+/gu, " ").trim())
    .filter((tag) => tag.length > 0);
  return tags.length > 0 ? tags : undefined;
}
