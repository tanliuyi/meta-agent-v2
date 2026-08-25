import type { Dirent } from "node:fs";
import { lstat, open, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MarketplaceGenerationReferenceTracker } from "./marketplace-generation-reference-tracker.ts";
import {
  markMarketplaceVersionInactive,
  readMarketplaceVersionOwner,
  validateInstalledMarketplacePlugin,
} from "./marketplace-installed-plugin.ts";
import { withMarketplacePluginLock } from "./marketplace-plugin-lock.ts";
import type { MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";

export interface MarketplacePluginGarbageCollectionResult {
  removedVersions: string[];
  removedRoots: string[];
  preservedModifiedRoots: string[];
}

interface MarketplacePluginGarbageCollectorOptions {
  now?(): number;
  retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export class MarketplacePluginGarbageCollector {
  private readonly registry: MarketplacePluginRegistry;
  private readonly references: Pick<MarketplaceGenerationReferenceTracker, "isReferenced">;
  private readonly marketplaceRoot: string;
  private readonly lockDirectory: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private running?: Promise<MarketplacePluginGarbageCollectionResult>;

  constructor(
    registry: MarketplacePluginRegistry,
    references: Pick<MarketplaceGenerationReferenceTracker, "isReferenced">,
    marketplaceRoot: string,
    lockDirectory: string,
    options: MarketplacePluginGarbageCollectorOptions = {},
  ) {
    this.registry = registry;
    this.references = references;
    this.marketplaceRoot = marketplaceRoot;
    this.lockDirectory = lockDirectory;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  run(): Promise<MarketplacePluginGarbageCollectionResult> {
    this.running ??= this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<MarketplacePluginGarbageCollectionResult> {
    const result: MarketplacePluginGarbageCollectionResult = {
      removedVersions: [],
      removedRoots: [],
      preservedModifiedRoots: [],
    };
    let entries: Dirent[];
    try {
      entries = await readdir(this.marketplaceRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return result;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const pluginId = entry.name;
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(pluginId)) continue;
      await withMarketplacePluginLock(this.lockDirectory, pluginId, async () => {
        await this.collectPlugin(pluginId, result);
      });
    }
    return result;
  }

  private async collectPlugin(pluginId: string, result: MarketplacePluginGarbageCollectionResult): Promise<void> {
    const rootPath = resolve(this.marketplaceRoot, pluginId);
    const rootInfo = await lstat(rootPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
    const active = (await this.registry.getInternalSnapshot()).plugins.find((plugin) => plugin.id === pluginId);
    if (active && resolve(active.rootPath) !== rootPath) return;
    const tombstone = active ? undefined : await readUninstallTombstone(rootPath, pluginId);
    if (!active && !tombstone) {
      // 中断的 root 拆除可能留下无 tombstone 的空根目录；rmdir 仅对空目录生效，带内容的未知根目录保持不动。
      try {
        await rmdir(rootPath);
        result.removedRoots.push(rootPath);
      } catch {
        // Roots with content but no tombstone belong to an unknown owner; leave them in place.
      }
      return;
    }
    if (!active) {
      const allowedRootEntries = new Set([".versions", ".meta-agent-market.json", ".meta-agent-versions"]);
      const rootEntries = await readdir(rootPath);
      if (rootEntries.some((entry) => !allowedRootEntries.has(entry))) {
        preserveRoot(result, rootPath);
        return;
      }
    }
    const versionsPath = join(rootPath, ".versions");
    let versions: Dirent[];
    try {
      const versionsInfo = await lstat(versionsPath);
      if (!versionsInfo.isDirectory() || versionsInfo.isSymbolicLink()) return;
      versions = await readdir(versionsPath, { withFileTypes: true });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      versions = [];
    }
    for (const version of versions) {
      if (!version.isDirectory() || version.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(version.name)) continue;
      if (active?.artifactHash === version.name) continue;
      const versionRoot = join(versionsPath, version.name);
      if (this.references.isReferenced(versionRoot)) continue;
      const owner = await readMarketplaceVersionOwner(rootPath, version.name);
      if (!owner) {
        preserveRoot(result, rootPath);
        continue;
      }
      try {
        await validateInstalledMarketplacePlugin(owner.record, this.marketplaceRoot);
      } catch {
        preserveRoot(result, rootPath);
        continue;
      }
      const now = this.now();
      const inactiveAt = owner.inactiveAt ?? now;
      if (owner.inactiveAt === undefined) await markMarketplaceVersionInactive(owner.record, inactiveAt);
      if (now - inactiveAt < this.retentionMs) continue;
      await rm(versionRoot, { recursive: true, force: true });
      await rm(join(rootPath, ".meta-agent-versions", `${version.name}.json`), {
        force: true,
      });
      result.removedVersions.push(versionRoot);
    }
    await syncDirectory(versionsPath).catch(() => undefined);
    if (active) return;
    const remaining = await readdir(versionsPath).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? [] : ["unknown"],
    );
    if (remaining.length > 0) return;
    const versionOwnersPath = join(rootPath, ".meta-agent-versions");
    const remainingOwners = await readdir(versionOwnersPath).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? [] : ["unknown"],
    );
    if (remainingOwners.length > 0) return;
    // 先移除内部目录，最后移除 tombstone：任何崩溃窗口都不会留下"有内容但无所有权元数据"的根目录。
    const removedOwnersDir = await rmdirIfEmpty(versionOwnersPath);
    const removedVersionsDir = await rmdirIfEmpty(versionsPath);
    if (!removedOwnersDir || !removedVersionsDir) return;
    await rm(join(rootPath, ".meta-agent-market.json"), { force: true });
    try {
      await rmdir(rootPath);
      result.removedRoots.push(rootPath);
    } catch {
      // Unknown user files keep the root in place.
    }
  }
}

async function rmdirIfEmpty(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    return isNodeError(error, "ENOENT");
  }
}

function preserveRoot(result: MarketplacePluginGarbageCollectionResult, rootPath: string): void {
  if (!result.preservedModifiedRoots.includes(rootPath)) result.preservedModifiedRoots.push(rootPath);
}

interface UninstallTombstone {
  version: 1;
  state: "uninstalled";
  pluginId: string;
}

async function readUninstallTombstone(rootPath: string, pluginId: string): Promise<UninstallTombstone | undefined> {
  const path = join(rootPath, ".meta-agent-market.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.version !== 1 || value.state !== "uninstalled" || value.pluginId !== pluginId) {
    return undefined;
  }
  return {
    version: 1,
    state: "uninstalled",
    pluginId,
  };
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
