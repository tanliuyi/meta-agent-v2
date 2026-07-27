import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

export interface ExtractedMarketplaceFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ExtractedMarketplaceArchive {
  files: Map<string, ExtractedMarketplaceFile>;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface MarketplaceArchiveLimits {
  maxFiles: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxFileBytes: number;
  maxPathBytes: number;
}

export const DEFAULT_MARKETPLACE_ARCHIVE_LIMITS: MarketplaceArchiveLimits = {
  maxFiles: 2_000,
  maxCompressedBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxPathBytes: 1_024,
};

export async function extractMarketplaceArchive(
  chunks: AsyncIterable<Uint8Array>,
  stagingRoot: string,
  limits: MarketplaceArchiveLimits = DEFAULT_MARKETPLACE_ARCHIVE_LIMITS,
): Promise<ExtractedMarketplaceArchive> {
  const files = new Map<string, ExtractedMarketplaceFile>();
  const normalizedNames = new Set<string>();
  const pendingWrites: Promise<void>[] = [];
  let fileCount = 0;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let failure: Error | undefined;

  const unzip = new Unzip((file) => {
    if (failure) {
      file.terminate();
      return;
    }
    try {
      const path = validateArchivePath(file.name, limits.maxPathBytes);
      const normalized = path.normalize("NFC").toLocaleLowerCase("en-US");
      if (normalizedNames.has(normalized)) throw new Error(`Marketplace archive has duplicate path: ${path}`);
      normalizedNames.add(normalized);
      fileCount += 1;
      if (fileCount > limits.maxFiles) throw new Error("Marketplace archive contains too many files");
      if (file.size !== undefined && file.size > limits.maxCompressedBytes) {
        throw new Error(`Marketplace archive file is too large: ${path}`);
      }
      if (file.originalSize !== undefined && file.originalSize > limits.maxFileBytes) {
        throw new Error(`Marketplace archive file is too large: ${path}`);
      }
      const content: Uint8Array[] = [];
      let size = 0;
      const hash = createHash("sha256");
      file.ondata = (error, data, final) => {
        if (failure) return;
        if (error) {
          failure = error;
          return;
        }
        size += data.byteLength;
        uncompressedBytes += data.byteLength;
        if (size > limits.maxFileBytes || uncompressedBytes > limits.maxUncompressedBytes) {
          failure = new Error(`Marketplace archive exceeds uncompressed size limits: ${path}`);
          file.terminate();
          return;
        }
        hash.update(data);
        content.push(data);
        if (!final) return;
        const target = resolve(stagingRoot, ...path.split("/"));
        const source = Buffer.concat(
          content.map((chunk) => Buffer.from(chunk)),
          size,
        );
        const write = mkdir(dirname(target), { recursive: true, mode: 0o700 })
          .then(() => writeDurableFile(target, source))
          .then(() => {
            files.set(path, { path, size, sha256: hash.digest("hex") });
          });
        pendingWrites.push(write);
        void write.catch((error: unknown) => {
          failure ??= error instanceof Error ? error : new Error(String(error));
        });
      };
      file.start();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      file.terminate();
    }
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of chunks) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > limits.maxCompressedBytes) throw new Error("Marketplace archive is too large");
      unzip.push(chunk, false);
      if (failure) throw failure;
    }
    unzip.push(new Uint8Array(0), true);
    if (failure) throw failure;
  } catch (error) {
    await Promise.allSettled(pendingWrites);
    throw error;
  }
  await Promise.all(pendingWrites);
  if (failure) throw failure;
  return { files, compressedBytes, uncompressedBytes };
}

export async function durablyFlushMarketplaceArchive(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error("Marketplace staging tree contains a symlink");
  if (info.isFile()) {
    const handle = await open(root, process.platform === "win32" ? "r+" : "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (!info.isDirectory()) throw new Error("Marketplace staging tree contains a special file");
  for (const entry of await readdir(root)) {
    await durablyFlushMarketplaceArchive(resolve(root, entry));
  }
  await syncDirectory(root);
}

async function writeDurableFile(path: string, source: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateArchivePath(value: string, maxPathBytes: number): string {
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > maxPathBytes ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    throw new Error(`Marketplace archive path is unsafe: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /^[A-Za-z]:/.test(segment))) {
    throw new Error(`Marketplace archive path is unsafe: ${value}`);
  }
  const sentinelRoot = resolve("marketplace-root");
  const resolved = resolve(sentinelRoot, ...segments);
  if (!resolved.startsWith(`${sentinelRoot}${sep}`)) throw new Error(`Marketplace archive path escapes root: ${value}`);
  return segments.join("/");
}
