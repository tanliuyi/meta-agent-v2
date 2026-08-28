import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Hex } from "@earendil-works/pi-office-engine";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 4;

/**
 * Write through a same-directory temporary file. Windows file scanners can
 * briefly lock the target, so transient rename failures are retried before an
 * in-place fallback. The source hash is checked immediately before replacement.
 */
export async function replaceFileAtomically(
  path: string,
  expectedSourceSha256: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await assertCurrentSource(path, expectedSourceSha256);
    await writeFile(temporary, bytes);

    for (let attempt = 0; ; attempt += 1) {
      await assertCurrentSource(path, expectedSourceSha256);
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (!isRetryableRenameError(error) || attempt >= RENAME_RETRIES) {
          if (!isRetryableRenameError(error)) throw error;
          break;
        }
        await sleep(50 * 2 ** attempt);
      }
    }

    await assertCurrentSource(path, expectedSourceSha256);
    await writeFile(path, bytes);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertCurrentSource(path: string, expectedSourceSha256: string): Promise<void> {
  if (sha256Hex(await readFile(path)) !== expectedSourceSha256) throw new Error("STALE_DOCUMENT");
}

function isRetryableRenameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    RETRYABLE_RENAME_CODES.has(error.code)
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
