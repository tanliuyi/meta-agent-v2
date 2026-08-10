import assert from "node:assert/strict";
import test from "node:test";
import { extractContent } from "../vendor/pi-web-access/extract.ts";

test("fetch_content does not perform local DNS or private-address preflight", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  const body = `<html><head><title>Desktop fetch</title></head><body><article><h1>Desktop fetch</h1><p>${"Public content. ".repeat(80)}</p></article></body></html>`;

  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  try {
    const result = await extractContent("https://developers.openai.com", undefined, {
      lookup: async () => {
        throw new Error("DNS lookup should not run for fetch_content");
      },
    });
    assert.equal(result.error, null);
    assert.equal(requestedUrl, "https://developers.openai.com/");
    assert.match(result.content, /Public content/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
