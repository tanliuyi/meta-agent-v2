import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { InstalledMarketplacePluginRecord } from "./marketplace-plugin-registry.ts";

export async function validateInstalledMarketplacePlugin(
  plugin: InstalledMarketplacePluginRecord,
  marketplaceRoot: string,
): Promise<string> {
  if (!isAbsolute(plugin.rootPath) || !isAbsolute(plugin.entryPath)) {
    throw new Error(`Marketplace extension paths must be absolute: ${plugin.id}`);
  }
  const rootInfo = await lstat(plugin.rootPath);
  const entryInfo = await lstat(plugin.entryPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !entryInfo.isFile() || entryInfo.isSymbolicLink()) {
    throw new Error(`Marketplace extension entry is not a regular managed file: ${plugin.id}`);
  }
  const canonicalMarketplaceRoot = await realpath(marketplaceRoot);
  const canonicalRoot = await realpath(plugin.rootPath);
  const canonicalEntry = await realpath(plugin.entryPath);
  if (canonicalRoot !== resolve(canonicalMarketplaceRoot, plugin.id)) {
    throw new Error(`Marketplace extension is outside its managed root: ${plugin.id}`);
  }
  const withinRoot = relative(canonicalRoot, canonicalEntry);
  if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    throw new Error(`Marketplace extension escapes managed root: ${plugin.id}`);
  }
  const expectedVersionRoot = resolve(canonicalRoot, ".versions", plugin.artifactHash);
  const versionRoot = await realpath(expectedVersionRoot);
  if (versionRoot !== expectedVersionRoot) {
    throw new Error(`Marketplace extension version root was redirected: ${plugin.id}`);
  }
  return resolve(canonicalEntry);
}

export interface MarketplaceVersionOwner {
  record: InstalledMarketplacePluginRecord;
  inactiveAt?: number;
}

export interface MarketplaceRootOwnership {
  record: InstalledMarketplacePluginRecord;
}

/** Reads the active installation ownership record from a plugin root, if present. */
export async function readMarketplaceRootOwnership(rootPath: string): Promise<MarketplaceRootOwnership | undefined> {
  const path = resolve(rootPath, ".meta-agent-market.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.state !== "installed" ||
    !isObject(value.record) ||
    typeof value.record.id !== "string" ||
    typeof value.record.artifactHash !== "string" ||
    typeof value.record.rootPath !== "string" ||
    typeof value.record.entryPath !== "string"
  ) {
    return undefined;
  }
  return { record: value.record as unknown as InstalledMarketplacePluginRecord };
}

export async function readMarketplaceVersionOwner(
  rootPath: string,
  artifactHash: string,
): Promise<MarketplaceVersionOwner | undefined> {
  const path = resolve(rootPath, ".meta-agent-versions", `${artifactHash}.json`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !isObject(value.record) ||
    value.record.artifactHash !== artifactHash ||
    value.record.rootPath !== rootPath ||
    typeof value.record.id !== "string" ||
    typeof value.record.entryPath !== "string" ||
    (value.inactiveAt !== undefined && (!Number.isSafeInteger(value.inactiveAt) || (value.inactiveAt as number) < 0))
  ) {
    return undefined;
  }
  return {
    record: value.record as unknown as InstalledMarketplacePluginRecord,
    ...(value.inactiveAt === undefined ? {} : { inactiveAt: value.inactiveAt as number }),
  };
}

export async function removeMarketplaceVersionIfOwned(
  record: InstalledMarketplacePluginRecord,
  marketplaceRoot: string,
): Promise<boolean> {
  try {
    await validateInstalledMarketplacePlugin(record, marketplaceRoot);
  } catch {
    return false;
  }
  await rm(resolve(record.rootPath, ".versions", record.artifactHash), { recursive: true, force: true });
  return true;
}

export async function writeMarketplaceBrokenMarker(record: InstalledMarketplacePluginRecord): Promise<void> {
  if (record.state !== "broken" || record.enabled) throw new Error("Marketplace broken marker record is invalid");
  await removeMarketplaceProjection(record.rootPath);
  await atomicWrite(
    resolve(record.rootPath, ".meta-agent-market.json"),
    `${JSON.stringify({ version: 1, state: "broken", record }, null, 2)}\n`,
  );
  await syncDirectory(record.rootPath);
}

export async function writeMarketplaceVersionOwner(record: InstalledMarketplacePluginRecord): Promise<void> {
  await writeMarketplaceVersionOwnerData(record);
}

export async function markMarketplaceVersionInactive(
  record: InstalledMarketplacePluginRecord,
  inactiveAt: number,
): Promise<void> {
  if (!Number.isSafeInteger(inactiveAt) || inactiveAt < 0) {
    throw new Error("Marketplace version inactivity timestamp is invalid");
  }
  await writeMarketplaceVersionOwnerData(record, inactiveAt);
}

async function writeMarketplaceVersionOwnerData(
  record: InstalledMarketplacePluginRecord,
  inactiveAt?: number,
): Promise<void> {
  const versionOwners = resolve(record.rootPath, ".meta-agent-versions");
  await mkdir(versionOwners, { recursive: true, mode: 0o700 });
  await atomicWrite(
    resolve(versionOwners, `${record.artifactHash}.json`),
    `${JSON.stringify({ version: 1, record, ...(inactiveAt === undefined ? {} : { inactiveAt }) }, null, 2)}\n`,
  );
  await syncDirectory(versionOwners);
}

export async function writeMarketplaceProjection(record: InstalledMarketplacePluginRecord): Promise<void> {
  const target = relative(record.rootPath, record.entryPath).split("\\").join("/");
  if (target.startsWith("../") || target === "..") throw new Error("Marketplace entry escapes the managed root");
  await writeMarketplaceVersionOwner(record);
  await atomicWrite(
    resolve(record.rootPath, "index.ts"),
    `export { default } from ${JSON.stringify(`./${target}`)};\n`,
  );
  await atomicWrite(
    resolve(record.rootPath, ".meta-agent-market.json"),
    `${JSON.stringify({ version: 1, state: "installed", record }, null, 2)}\n`,
  );
  await syncDirectory(record.rootPath);
}

export async function writeMarketplaceUninstallTombstone(
  record: InstalledMarketplacePluginRecord,
  operationId: string,
  uninstalledAt: number,
): Promise<void> {
  await removeMarketplaceProjection(record.rootPath);
  await atomicWrite(
    resolve(record.rootPath, ".meta-agent-market.json"),
    `${JSON.stringify(
      {
        version: 1,
        state: "uninstalled",
        operationId,
        pluginId: record.id,
        marketplaceId: record.marketplaceId,
        artifactHash: record.artifactHash,
        uninstalledAt,
      },
      null,
      2,
    )}\n`,
  );
  await syncDirectory(record.rootPath);
}

export async function removeMarketplaceProjection(rootPath: string): Promise<void> {
  await rm(resolve(rootPath, "index.ts"), { force: true });
  await syncDirectory(rootPath);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
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

function isObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
