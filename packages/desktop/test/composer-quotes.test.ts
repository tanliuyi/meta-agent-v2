import type { QuoteInfo } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  appendComposerQuote,
  getComposerQuotes,
  getMessageQuotes,
  removeComposerQuote,
  toComposerQuote,
} from "../src/renderer/src/runtime/composer-quotes.ts";
import type { PiQuote } from "../src/shared/contracts.ts";

const first: PiQuote = { text: "第一段", messageId: "assistant-1" };
const second: PiQuote = { text: "第二段", messageId: "assistant-2" };

describe("composer quotes", () => {
  it("keeps a single quote compatible with assistant-ui's existing carrier", () => {
    const value = toComposerQuote([first]);

    expect(value).toEqual(first);
    expect(getComposerQuotes(value)).toEqual([first]);
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
});
