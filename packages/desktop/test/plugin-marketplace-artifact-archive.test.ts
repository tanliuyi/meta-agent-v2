import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  durablyFlushMarketplaceArchive,
  extractMarketplaceArchive,
} from "../src/main/plugins/marketplace-artifact-archive.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extractMarketplaceArchive", () => {
  it("extracts and flushes an ordinary nested payload path", async () => {
    const root = createRoot();
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    const archive = zipSync({ "payload/index.ts": new Uint8Array([1, 2, 3]) });

    await extractMarketplaceArchive(chunks(archive), staging);
    await expect(durablyFlushMarketplaceArchive(staging)).resolves.toBeUndefined();
    await expect(readFile(join(staging, "payload", "index.ts"))).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects a drive-prefixed non-first path segment", async () => {
    const root = createRoot();
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    const archive = zipSync({ "payload/D:/escape.ts": new Uint8Array([1]) });

    await expect(extractMarketplaceArchive(chunks(archive), staging)).rejects.toThrow("path is unsafe");
  });

  it("rejects traversal paths without writing outside the staging root", async () => {
    const root = createRoot();
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    const archive = zipSync({ "../escape.ts": new Uint8Array([1]) });

    await expect(extractMarketplaceArchive(chunks(archive), staging)).rejects.toThrow("path is unsafe");
    await expect(readFile(join(root, "escape.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects case-insensitive path collisions", async () => {
    const root = createRoot();
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    const archive = zipSync({
      "payload/index.ts": new Uint8Array([1]),
      "Payload/index.ts": new Uint8Array([2]),
    });

    await expect(extractMarketplaceArchive(chunks(archive), staging)).rejects.toThrow("duplicate path");
  });

  it("rejects paths beyond the configured UTF-8 byte limit", async () => {
    const root = createRoot();
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    const archive = zipSync({ [`payload/${"a".repeat(32)}.ts`]: new Uint8Array([1]) });

    await expect(
      extractMarketplaceArchive(chunks(archive), staging, {
        maxFiles: 10,
        maxCompressedBytes: 1_024,
        maxUncompressedBytes: 1_024,
        maxFileBytes: 1_024,
        maxPathBytes: 16,
      }),
    ).rejects.toThrow("path is unsafe");
  });
});

function createRoot(): string {
  const root = join(tmpdir(), `plugin-marketplace-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  return root;
}

async function* chunks(archive: Uint8Array): AsyncGenerator<Uint8Array> {
  const midpoint = Math.ceil(archive.byteLength / 2);
  yield archive.subarray(0, midpoint);
  yield archive.subarray(midpoint);
}
