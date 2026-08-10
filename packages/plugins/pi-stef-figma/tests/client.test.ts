import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FigmaCache } from "../src/cache/FigmaCache";
import { FigmaClient, FigmaApiError } from "../src/client/FigmaClient";

describe("FigmaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adds auth, retries 429 with Retry-After, and returns parsed JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "Design", version: "v1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FigmaClient({ apiToken: "token", retryAfterCapMs: 1 });
    const result = await client.getFile("abc123", { depth: 1 });

    expect(result).toMatchObject({ name: "Design", version: "v1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("X-Figma-Token")).toBe("token");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("depth=1");
  });

  it("throws actionable FigmaApiError values for failed responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403, statusText: "Forbidden" }))
      .mockResolvedValueOnce(new Response("missing", { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(new Response("too large", { status: 413, statusText: "Payload Too Large" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FigmaClient({ apiToken: "token", maxRetries: 0 });

    await expect(client.getFile("forbidden")).rejects.toMatchObject({
      name: "FigmaApiError",
      status: 403,
    } satisfies Partial<FigmaApiError>);
    await expect(client.getFile("missing")).rejects.toMatchObject({
      name: "FigmaApiError",
      status: 404,
    } satisfies Partial<FigmaApiError>);
    await expect(client.getFile("large")).rejects.toMatchObject({
      name: "FigmaApiError",
      status: 413,
    } satisfies Partial<FigmaApiError>);
  });

  it("rejects empty direct tokens before making a request", () => {
    expect(() => new FigmaClient({ apiToken: "" })).toThrow("token is required");
  });

  it("caches versioned JSON responses but never caches expiring image URLs", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-cache-"));
    const cache = new FigmaCache(cacheDir);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "Design", version: "v1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "Design", version: "v1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "Design", version: "v1" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ err: null, images: { "1:2": "https://img.example/one.png" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ err: null, images: { "1:2": "https://img.example/two.png" } }), {
          status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new FigmaClient({ apiToken: "token", cache });

    await expect(client.getFile("abc123")).resolves.toMatchObject({ name: "Design" });
    await expect(client.getFile("abc123")).resolves.toMatchObject({ name: "Design" });
    await expect(client.getImageRenderUrls("abc123", ["1:2"])).resolves.toMatchObject({
      images: { "1:2": "https://img.example/one.png" },
    });
    await expect(client.getImageRenderUrls("abc123", ["1:2"])).resolves.toMatchObject({
      images: { "1:2": "https://img.example/two.png" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("evicts old cache entries and writes private cache permissions", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-cache-"));
    const cache = new FigmaCache(cacheDir, 1);

    await cache.set(["one"], { value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.set(["two"], { value: 2 });

    expect(await cache.get(["one"])).toBeNull();
    expect(await cache.get(["two"])).toEqual({ value: 2 });
    // Windows ignores most permission bits; only enforce modes on POSIX.
    if (process.platform !== "win32") {
      expect((fs.statSync(cacheDir).mode & 0o777).toString(8)).toBe("700");
      const [file] = fs.readdirSync(cacheDir);
      expect((fs.statSync(path.join(cacheDir, file)).mode & 0o777).toString(8)).toBe("600");
    }
  });
});
