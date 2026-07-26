import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  const expectedFiles = new Map(plugin.verifiedFiles.map((file) => [file.path, file]));
  const actualFiles = await listManagedFiles(versionRoot);
  if (
    expectedFiles.size === 0 ||
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((path) => !expectedFiles.has(path))
  ) {
    throw new Error(`Marketplace extension file set was modified: ${plugin.id}`);
  }
  let entryVerified = false;
  for (const [path, expected] of expectedFiles) {
    if (!isManagedRelativePath(path)) throw new Error(`Marketplace extension file path is invalid: ${plugin.id}`);
    const filePath = resolve(versionRoot, ...path.split("/"));
    const info = await lstat(filePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== expected.size ||
      (await hashFile(filePath)) !== expected.sha256
    ) {
      throw new Error(`Marketplace extension file integrity failed: ${plugin.id}`);
    }
    if ((await realpath(filePath)) === canonicalEntry) entryVerified = true;
  }
  if (!entryVerified) throw new Error(`Marketplace extension entry is not in its verified file set: ${plugin.id}`);
  return resolve(canonicalEntry);
}

export interface MarketplaceVersionOwner {
  record: InstalledMarketplacePluginRecord;
  inactiveAt?: number;
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
    !Array.isArray(value.record.verifiedFiles) ||
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

export async function validateMarketplaceOwnershipAndProjection(
  record: InstalledMarketplacePluginRecord,
): Promise<void> {
  const ownershipPath = resolve(record.rootPath, ".meta-agent-market.json");
  const projectionPath = resolve(record.rootPath, "index.ts");
  const ownershipInfo = await lstat(ownershipPath);
  if (!ownershipInfo.isFile() || ownershipInfo.isSymbolicLink()) {
    throw new Error(`Marketplace extension ownership is unavailable: ${record.id}`);
  }
  let ownership: unknown;
  try {
    ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
  } catch {
    throw new Error(`Marketplace extension ownership is invalid: ${record.id}`);
  }
  if (
    !isObject(ownership) ||
    ownership.version !== 1 ||
    ownership.state !== record.state ||
    !isDeepStrictEqual(ownership.record, record)
  ) {
    throw new Error(`Marketplace extension ownership does not match the registry: ${record.id}`);
  }
  if (record.state === "broken") {
    if (await pathExists(projectionPath)) {
      throw new Error(`Broken marketplace extension still has a projection: ${record.id}`);
    }
    return;
  }
  const projectionInfo = await lstat(projectionPath);
  if (!projectionInfo.isFile() || projectionInfo.isSymbolicLink()) {
    throw new Error(`Marketplace extension projection is unavailable: ${record.id}`);
  }
  const target = relative(record.rootPath, record.entryPath).split("\\").join("/");
  const expectedProjection = `export { default } from ${JSON.stringify(`./${target}`)};\n`;
  if ((await readFile(projectionPath, "utf8")) !== expectedProjection) {
    throw new Error(`Marketplace extension projection was modified: ${record.id}`);
  }
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
  preserveFiles = false,
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
        preserveFiles,
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

async function listManagedFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Marketplace extension contains a symlink: ${path}`);
    if (entry.isDirectory()) files.push(...(await listManagedFiles(resolve(root, entry.name), path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Marketplace extension contains a special file: ${path}`);
  }
  return files;
}

function isManagedRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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
