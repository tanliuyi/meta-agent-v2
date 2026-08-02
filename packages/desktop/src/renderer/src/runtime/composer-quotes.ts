import type { QuoteInfo } from "@assistant-ui/react";
import type { PiQuote } from "../../../shared/contracts.ts";

/** The assistant-ui quote carrier keeps the existing API while carrying multiple quotes. */
export type ComposerQuoteValue = QuoteInfo & {
  readonly quotes?: readonly PiQuote[];
};

export interface ComposerQuoteTarget {
  getState(): { quote: QuoteInfo | undefined };
  setQuote(quote: QuoteInfo | undefined): void;
}

export function getComposerQuotes(value: QuoteInfo | undefined): readonly PiQuote[] {
  if (!value) return [];
  const nested = parseQuoteValue(asRecord(value)?.quotes);
  return nested.length > 0 ? nested : [value];
}

export function parseQuoteValue(value: unknown): PiQuote[] {
  if (Array.isArray(value)) return value.flatMap((item) => parseQuoteValue(item));
  const record = asRecord(value);
  if (!record) return [];

  const nested = parseQuoteValue(record.quotes);
  if (nested.length > 0) return nested;

  const quote = normalizeQuote(record);
  return quote ? [quote] : [];
}

export function getMessageQuotes(custom: unknown): readonly PiQuote[] {
  const record = asRecord(custom);
  if (!record) return [];
  const quotes = parseQuoteValue(record.quotes);
  return quotes.length > 0 ? quotes : parseQuoteValue(record.quote);
}

export function toComposerQuote(quotes: readonly PiQuote[]): QuoteInfo | undefined {
  const normalized = quotes.flatMap((quote) => {
    const value = normalizeQuote(quote);
    return value ? [value] : [];
  });
  const first = normalized[0];
  if (!first) return undefined;
  if (normalized.length === 1) return first;

  const carrier: ComposerQuoteValue = { ...first, quotes: normalized };
  return carrier;
}

export function appendComposerQuote(target: ComposerQuoteTarget, quote: PiQuote): void {
  const current = getComposerQuotes(target.getState().quote);
  if (current.some((item) => item.text === quote.text && item.messageId === quote.messageId)) return;
  target.setQuote(toComposerQuote([...current, quote]));
}

export function removeComposerQuote(target: ComposerQuoteTarget, index: number): void {
  const current = getComposerQuotes(target.getState().quote);
  if (index < 0 || index >= current.length) return;
  target.setQuote(toComposerQuote(current.filter((_, itemIndex) => itemIndex !== index)));
}

function normalizeQuote(value: unknown): PiQuote | undefined {
  const record = asRecord(value);
  if (!record || typeof record.text !== "string" || typeof record.messageId !== "string") return undefined;
  const text = record.text.trim();
  const messageId = record.messageId.trim();
  return text && messageId ? { text, messageId } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
