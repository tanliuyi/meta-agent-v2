import { renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export async function withRuntimeLock<T>(runtimeRoot: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(runtimeRoot, { recursive: true });
  const release = await lockfile.lock(runtimeRoot, {
    realpath: false,
    stale: 10 * 60_000,
    update: 30_000,
    retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 2_000, randomize: true },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function activateRuntime(runtimeRoot: string, finalRoot: string): void {
  const temporaryPath = join(runtimeRoot, `active.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ root: finalRoot })}\n`, { flag: "wx" });
    renameSync(temporaryPath, join(runtimeRoot, "active.json"));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
