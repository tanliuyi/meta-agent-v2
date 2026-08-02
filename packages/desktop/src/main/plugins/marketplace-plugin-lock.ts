import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

/** Per-plugin mutation lock used by the installer and garbage collector. */
export async function withMarketplacePluginLock<T>(
  lockDirectory: string,
  pluginId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!SAFE_ID.test(pluginId)) throw new Error("Marketplace plugin lock ID is invalid");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const target = join(lockDirectory, pluginId);
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 5_000,
    update: 1_000,
    retries: { retries: 12, factor: 1.4, minTimeout: 100, maxTimeout: 1_000, randomize: true },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
