import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLUGIN_MARKETPLACE } from "../src/main/plugins/default-plugin-marketplace.ts";
import { targetMatchesRuntime } from "../src/main/plugins/marketplace-artifact-manifest.ts";
import { MarketplaceCatalogService } from "../src/main/plugins/marketplace-catalog-service.ts";
import {
  type MarketplaceEndpoint,
  MarketplaceEndpointSettingsService,
  MISSING_MARKETPLACE_ENDPOINT_REVISION,
} from "../src/main/plugins/marketplace-endpoint-settings-service.ts";
import { readBoundedJsonResponse } from "../src/main/plugins/marketplace-http.ts";

const directories: string[] = [];

function wellKnown(baseUrl = "https://market.example/", marketplaceId = "example.market") {
  return {
    data: {
      protocolVersion: 1,
      marketplaceId,
      apiRoot: `${baseUrl}v1/`,
    },
    signature: { algorithm: "ignored", keyId: "ignored", value: "ignored" },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("marketplace runtime compatibility", () => {
  const runtime = {
    nodeVersion: "v24.0.0",
    modulesAbi: "137",
    napi: "10",
    platform: "linux",
    arch: "x64",
    osRelease: "linux",
    libc: "glibc",
    toolchain: "gcc",
    piVersion: "0.80.7",
    runtimeCompatibilityId: "fixture",
  };

  it("fails invalid minimum N-API levels closed", () => {
    expect(targetMatchesRuntime({ platform: "linux", arch: "x64", minimumNapi: "10" }, runtime)).toBe(true);
    expect(targetMatchesRuntime({ platform: "linux", arch: "x64", minimumNapi: "invalid" }, runtime)).toBe(false);
    expect(targetMatchesRuntime({ platform: "linux", arch: "x64", minimumNapi: "0" }, runtime)).toBe(false);
    expect(targetMatchesRuntime({ platform: "linux", arch: "x64", minimumNapi: "9007199254740992" }, runtime)).toBe(
      false,
    );
  });
});

describe("marketplace HTTP bounds", () => {
  it("rejects a streamed response as soon as decoded bytes exceed the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"a":'));
        controller.enqueue(Buffer.from('"oversized"}'));
        controller.close();
      },
    });
    await expect(readBoundedJsonResponse(new Response(body), 8, "Marketplace fixture")).rejects.toThrow(
      "Marketplace fixture is too large",
    );
  });
});

describe("MarketplaceEndpointSettingsService", () => {
  it("uses the pinned distribution marketplace when no active settings exist", async () => {
    const directory = join(tmpdir(), `marketplace-default-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const service = new MarketplaceEndpointSettingsService(directory, {
      defaultEndpoint: DEFAULT_PLUGIN_MARKETPLACE,
    });

    await expect(service.getSettings()).resolves.toEqual({
      revision: MISSING_MARKETPLACE_ENDPOINT_REVISION,
      activeMarketplaceId: "meta-agent-development",
      endpoints: [
        expect.objectContaining({
          marketplaceId: "meta-agent-development",
          baseUrl: "http://100.91.230.10:4317/",
          active: true,
        }),
      ],
    });
    await expect(service.getActiveEndpoint()).resolves.toMatchObject({
      apiRoot: "http://100.91.230.10:4317/v1/",
    });
  });

  it("tests and atomically saves a normalized endpoint", async () => {
    const directory = join(tmpdir(), `marketplace-endpoint-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const fetch = vi.fn(async () => jsonResponse(wellKnown()));
    let nextId = 0;
    const service = new MarketplaceEndpointSettingsService(directory, {
      fetch,
      createId: () => `id-${++nextId}`,
    });
    const initial = await service.getSettings();
    expect(initial).toEqual({ revision: MISSING_MARKETPLACE_ENDPOINT_REVISION, endpoints: [] });

    const tested = await service.testEndpoint({ baseUrl: "https://market.example" });
    expect(tested).toMatchObject({
      status: "ready",
      endpoint: { marketplaceId: "example.market", baseUrl: "https://market.example/" },
    });
    if (tested.status !== "ready") throw new Error("endpoint test failed");

    const saved = await service.saveEndpoint({
      requestId: "save",
      expectedRevision: initial.revision,
      baseUrl: "https://market.example",
    });
    expect(saved).toMatchObject({
      status: "saved",
      snapshot: { activeMarketplaceId: "example.market", endpoints: [{ active: true }] },
    });
    if (saved.status !== "saved") throw new Error("endpoint save failed");
    const endpointPath = join(directory, "plugins", "marketplace-endpoints.json");
    const bytes = await readFile(endpointPath);
    expect(saved.snapshot.revision).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(JSON.stringify(saved)).not.toContain("publicKey");
    const source = JSON.parse(bytes.toString("utf8"));
    expect(source.endpoints[0]).not.toHaveProperty("privateKey");
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://market.example/.well-known/meta-agent-marketplace.json"),
      expect.objectContaining({ redirect: "error" }),
    );
    await expect(service.testEndpoint({ baseUrl: "https://mirror.example" })).resolves.toMatchObject({
      status: "ready",
    });
    const restartedWithDefault = new MarketplaceEndpointSettingsService(directory, {
      fetch,
      defaultEndpoint: DEFAULT_PLUGIN_MARKETPLACE,
    });
    await expect(restartedWithDefault.getSettings()).resolves.toMatchObject({
      activeMarketplaceId: "example.market",
      endpoints: [
        { marketplaceId: "example.market", active: true },
        { marketplaceId: "meta-agent-development", active: false },
      ],
    });
  });

  it("validates compiled-in endpoint URLs at construction", () => {
    const directory = join(tmpdir(), `marketplace-default-validate-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const valid: MarketplaceEndpoint = {
      marketplaceId: "fixture.market",
      baseUrl: "https://fixture.example/",
      apiRoot: "https://fixture.example/v1/",
      active: true,
    };
    const build = (defaultEndpoint: MarketplaceEndpoint) =>
      new MarketplaceEndpointSettingsService(directory, { defaultEndpoint });

    expect(() => build(valid)).not.toThrow();
    expect(() => build({ ...valid, active: false })).toThrow("Default marketplace endpoint must be active");
    expect(() => build({ ...valid, apiRoot: "https://fixture.example/v1" })).toThrow(
      "Default marketplace API root is not normalized",
    );
  });

  it("does not persist the injected default marketplace when saving another endpoint", async () => {
    const directory = join(tmpdir(), `marketplace-default-persist-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const service = new MarketplaceEndpointSettingsService(directory, {
      fetch: async () => jsonResponse(wellKnown()),
      defaultEndpoint: DEFAULT_PLUGIN_MARKETPLACE,
    });
    const initial = await service.getSettings();
    expect(initial.activeMarketplaceId).toBe("meta-agent-development");

    const tested = await service.testEndpoint({ baseUrl: "https://market.example" });
    if (tested.status !== "ready") throw new Error("endpoint test failed");
    await expect(
      service.saveEndpoint({
        requestId: "save-other",
        expectedRevision: initial.revision,
        baseUrl: "https://market.example",
      }),
    ).resolves.toMatchObject({ status: "saved" });

    const source = JSON.parse(await readFile(join(directory, "plugins", "marketplace-endpoints.json"), "utf8"));
    expect(source.activeMarketplaceId).toBe("example.market");
    expect(source.endpoints).toEqual([expect.objectContaining({ marketplaceId: "example.market", active: true })]);
    await expect(service.getEndpoint("meta-agent-development")).resolves.toMatchObject({
      active: false,
    });
  });

  it("injects the default over a dangling active pointer and preserves stored endpoints across a save", async () => {
    const directory = join(tmpdir(), `marketplace-default-dangling-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const stored = {
      marketplaceId: "example.market",
      baseUrl: "https://market.example/",
      apiRoot: "https://market.example/v1/",
      active: false,
    };
    await mkdir(join(directory, "plugins"), { recursive: true });
    await writeFile(
      join(directory, "plugins", "marketplace-endpoints.json"),
      `${JSON.stringify({ version: 1, activeMarketplaceId: "ghost.market", endpoints: [stored] })}\n`,
      "utf8",
    );
    const service = new MarketplaceEndpointSettingsService(directory, {
      fetch: async () => jsonResponse(wellKnown("https://mirror.example/", "mirror.market")),
      defaultEndpoint: DEFAULT_PLUGIN_MARKETPLACE,
    });

    const settings = await service.getSettings();
    expect(settings).toMatchObject({
      activeMarketplaceId: "meta-agent-development",
      endpoints: [
        { marketplaceId: "example.market", active: false },
        { marketplaceId: "meta-agent-development", active: true },
      ],
    });

    const tested = await service.testEndpoint({ baseUrl: "https://mirror.example" });
    if (tested.status !== "ready") throw new Error("endpoint test failed");
    await expect(
      service.saveEndpoint({
        requestId: "save-mirror",
        expectedRevision: settings.revision,
        baseUrl: "https://mirror.example",
      }),
    ).resolves.toMatchObject({ status: "saved" });

    const source = JSON.parse(await readFile(join(directory, "plugins", "marketplace-endpoints.json"), "utf8"));
    expect(source.activeMarketplaceId).toBe("mirror.market");
    expect(source.endpoints).toEqual([
      stored,
      expect.objectContaining({ marketplaceId: "mirror.market", active: true }),
    ]);
  });

  it("requires the current settings revision", async () => {
    const directory = join(tmpdir(), `marketplace-confirm-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const service = new MarketplaceEndpointSettingsService(directory, {
      fetch: async () => jsonResponse(wellKnown()),
      createId: () => "confirmation",
    });
    const initial = await service.getSettings();

    await expect(
      service.saveEndpoint({
        requestId: "save",
        expectedRevision: initial.revision,
        baseUrl: "https://market.example",
      }),
    ).resolves.toMatchObject({ status: "saved" });

    await mkdir(join(directory, "plugins"), { recursive: true });
    await writeFile(
      join(directory, "plugins", "marketplace-endpoints.json"),
      `${JSON.stringify({ version: 1, endpoints: [] })}\n`,
      "utf8",
    );
    await expect(
      service.saveEndpoint({
        requestId: "stale",
        expectedRevision: initial.revision,
        baseUrl: "https://market.example",
      }),
    ).resolves.toMatchObject({ status: "conflict" });
  });

  it("ignores legacy discovery signatures", async () => {
    const directory = join(tmpdir(), `marketplace-signature-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const envelope = wellKnown();
    envelope.data.apiRoot = "https://attacker.example/v1/";
    const service = new MarketplaceEndpointSettingsService(directory, {
      fetch: async () => jsonResponse(envelope),
    });

    await expect(service.testEndpoint({ baseUrl: "https://market.example" })).resolves.toMatchObject({
      status: "ready",
      endpoint: { apiRoot: "https://attacker.example/v1/" },
    });
  });

  it("accepts HTTP and HTTPS while rejecting structurally unsafe endpoint URLs", async () => {
    const directory = join(tmpdir(), `marketplace-http-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    const service = new MarketplaceEndpointSettingsService(directory, {
      fetch: async (input) => {
        const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
        return jsonResponse(wellKnown(`${origin}/`));
      },
    });
    await expect(service.testEndpoint({ baseUrl: "http://localhost:4100" })).resolves.toMatchObject({
      status: "ready",
    });
    await expect(service.testEndpoint({ baseUrl: "http://market.example" })).resolves.toMatchObject({
      status: "ready",
    });
    for (const baseUrl of [
      "ftp://market.example",
      "http://user:password@market.example",
      "http://market.example/path?token=secret",
      "http://market.example/path#fragment",
      "http://market.example/a/%2e%2e/b",
    ]) {
      await expect(service.testEndpoint({ baseUrl })).resolves.toMatchObject({
        status: "invalid",
        code: "MARKETPLACE_ENDPOINT_INVALID",
      });
    }
  });
});

describe("MarketplaceCatalogService", () => {
  it("fetches a bounded validated page and falls back to stale memory cache", async () => {
    const endpoint = {
      marketplaceId: "example.market",
      baseUrl: "https://market.example/",
      apiRoot: "https://market.example/v1/",
      active: true,
    };
    const endpoints = {
      getSettings: vi.fn(async () => ({
        revision: "one",
        activeMarketplaceId: endpoint.marketplaceId,
        endpoints: [endpoint],
      })),
    };
    const page = {
      plugins: [
        {
          id: "plugin.one",
          name: "Plugin One",
          description: "First plugin",
          publisher: { id: "publisher", displayName: "Publisher", verified: true },
          categories: ["tools"],
          latestVersion: "1.0.0",
          compatibleVersion: "1.0.0",
          containsNativeCode: false,
          status: "available",
          publishedAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(page)).mockRejectedValueOnce(new Error("offline"));
    const service = new MarketplaceCatalogService(endpoints as never, {
      fetch,
      now: () => 10,
      desktopVersion: "1.2.3",
      runtimeCompatibility: {
        nodeVersion: "v24.0.0",
        modulesAbi: "137",
        napi: "10",
        platform: "darwin",
        arch: "arm64",
        osRelease: "darwin-24",
        libc: "none",
        toolchain: "apple-clang",
        piVersion: "0.80.7",
        runtimeCompatibilityId: "fixture",
      },
    });

    await expect(service.list({ query: "one", limit: 10 })).resolves.toMatchObject({
      marketplaceId: "example.market",
      source: "network",
      stale: false,
      plugins: [{ id: "plugin.one" }],
    });
    await expect(service.list({ query: "one", limit: 10 })).resolves.toMatchObject({
      source: "cache",
      stale: true,
    });
    const requestedUrl = String(fetch.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("query=one");
    expect(requestedUrl).toContain("desktopVersion=1.2.3");
    expect(requestedUrl).toContain("platform=darwin");
    expect(requestedUrl).toContain("modulesAbi=137");
  });

  it("does not fetch without a saved active endpoint", async () => {
    const fetch = vi.fn();
    const service = new MarketplaceCatalogService(
      { getSettings: async () => ({ revision: "missing", endpoints: [] }) } as never,
      { fetch },
    );
    await expect(service.list()).rejects.toMatchObject({ code: "MARKETPLACE_ENDPOINT_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
