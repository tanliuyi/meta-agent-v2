import { generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceRevocationService } from "../src/main/plugins/marketplace-revocation-service.ts";

const roots: string[] = [];
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const endpoint = {
  marketplaceId: "example.market",
  baseUrl: "https://market.example/",
  apiRoot: "https://market.example/v1/",
  artifactOrigins: ["https://market.example"],
  signing: {
    algorithm: "ed25519" as const,
    keyId: "key-1",
    publicKey,
    fingerprint: "sha256:key",
  },
  active: true,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MarketplaceRevocationService", () => {
  it("verifies, caches, and decorates a blocked plugin without exposing signed data", async () => {
    const harness = createHarness(
      envelope({
        sequence: 2,
        pluginVersions: [
          {
            pluginId: "plugin.one",
            version: "1.0.0",
            status: "blocked",
            reasonCode: "SECURITY",
            message: "Known unsafe behavior",
            replacementVersion: "1.1.0",
          },
        ],
      }),
    );

    await harness.service.refresh(endpoint.marketplaceId);
    const decorated = await harness.service.decorateSnapshot({
      revision: "one",
      plugins: [pluginSummary()],
    });

    expect(decorated).toEqual({
      revision: "one",
      revocationChecks: [{ marketplaceId: "example.market", status: "fresh", checkedAt: 1_000 }],
      plugins: [
        expect.objectContaining({
          id: "plugin.one",
          revocation: {
            status: "blocked",
            reasonCode: "SECURITY",
            message: "Known unsafe behavior",
            replacementVersion: "1.1.0",
            checkedAt: 1_000,
            stale: false,
          },
        }),
      ],
    });
    expect(JSON.stringify(decorated)).not.toContain("signature");
    expect(JSON.stringify(decorated)).not.toContain(publicKey);
  });

  it("rejects sequence rollback and same-sequence equivocation", async () => {
    let response = envelope({ sequence: 2 });
    const harness = createHarness(() => response);
    await harness.service.refresh(endpoint.marketplaceId);

    response = envelope({ sequence: 1 });
    await expect(harness.service.refresh(endpoint.marketplaceId)).rejects.toThrow("sequence rollback");

    response = envelope({ sequence: 2, revokedKeys: [{ keyId: "other-key", reasonCode: "TEST" }] });
    await expect(harness.service.refresh(endpoint.marketplaceId)).rejects.toThrow("sequence equivocation");
  });

  it("blocks new artifact use for withdrawn versions and stale snapshots", async () => {
    let response = envelope({
      sequence: 3,
      pluginVersions: [
        {
          pluginId: "plugin.one",
          version: "1.0.0",
          artifactIds: ["artifact-one"],
          status: "withdrawn",
          reasonCode: "INTEGRITY",
          message: "Artifact withdrawn",
        },
      ],
    });
    const harness = createHarness(() => response);

    await expect(
      harness.service.assertArtifactAllowed("example.market", "plugin.one", "1.0.0", "artifact-one"),
    ).rejects.toThrow("withdrawn");

    response = envelope({ sequence: 4, issuedAt: 100, nextUpdateAt: 999 });
    await expect(
      harness.service.assertArtifactAllowed("example.market", "plugin.one", "2.0.0", "artifact-two"),
    ).rejects.toThrow("already stale");
  });

  it("rejects an invalid revocation signature", async () => {
    const value = envelope({ sequence: 1 });
    value.signature.value = Buffer.alloc(64).toString("base64");
    const harness = createHarness(value);

    await expect(harness.service.refresh(endpoint.marketplaceId)).rejects.toThrow("signature is invalid");
  });
});

function createHarness(source: ReturnType<typeof envelope> | (() => ReturnType<typeof envelope>)) {
  const root = join(tmpdir(), `marketplace-revocation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const fetch = vi.fn(async () => Response.json(typeof source === "function" ? source() : source));
  const endpoints = { getTrustedEndpoint: vi.fn(async () => endpoint) };
  const service = new MarketplaceRevocationService(endpoints as never, root, {
    fetch,
    now: () => 1_000,
    createId: () => "cache-write",
  });
  return { root, fetch, service };
}

function envelope(
  overrides: Partial<{
    sequence: number;
    issuedAt: number;
    nextUpdateAt: number;
    revokedKeys: Array<{ keyId: string; reasonCode: string }>;
    pluginVersions: Array<{
      pluginId: string;
      version: string;
      artifactIds?: string[];
      status: "withdrawn" | "blocked";
      reasonCode: string;
      message: string;
      replacementVersion?: string;
    }>;
  }> = {},
) {
  const data = {
    marketplaceId: "example.market",
    sequence: overrides.sequence ?? 1,
    issuedAt: overrides.issuedAt ?? 900,
    nextUpdateAt: overrides.nextUpdateAt ?? 5_000,
    revokedKeys: overrides.revokedKeys ?? [],
    pluginVersions: overrides.pluginVersions ?? [],
  };
  return {
    data,
    signature: {
      algorithm: "ed25519" as const,
      keyId: "key-1",
      value: sign(null, Buffer.from(canonicalJson(data), "utf8"), keyPair.privateKey).toString("base64"),
    },
  };
}

function pluginSummary() {
  return {
    id: "plugin.one",
    displayName: "Plugin One",
    marketplaceId: "example.market",
    version: "1.0.0",
    artifactId: "artifact-one",
    enabled: true,
    capabilities: [],
    containsNativeCode: false,
    state: "installed" as const,
    installedAt: 1,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value");
}
