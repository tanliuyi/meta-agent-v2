import type { Dirent } from "node:fs";
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  markMarketplaceVersionInactive,
  readMarketplaceRootOwnership,
  validateInstalledMarketplacePlugin,
  writeMarketplaceBrokenMarker,
  writeMarketplaceProjection,
  writeMarketplaceUninstallTombstone,
} from "./marketplace-installed-plugin.ts";
import type { InstalledMarketplacePluginRecord, MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";

interface MarketplacePluginReconcilerOptions {
  now?(): number;
  log?(message: string): void;
}

const VERSION_DIRECTORY = ".versions";
const PLUGIN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const ARTIFACT_HASH = /^[a-f0-9]{64}$/;

/**
 * Startup reconciliation without a durable apply journal.
 *
 * The registry is the single commit point. This pass restores the two
 * crash windows that remain around it:
 *
 * - registry committed but projection not written -> rewrite the projection;
 * - version payload landed but registry never committed -> remove the orphan;
 * - uninstall committed but tombstone not written -> complete the tombstone.
 *
 * Anything that cannot be proven consistent is marked broken instead of being
 * deleted or guessed.
 */
export class MarketplacePluginReconciler {
  private readonly registry: MarketplacePluginRegistry;
  private readonly marketplaceRoot: string;
  private readonly userDataDir: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    registry: MarketplacePluginRegistry,
    agentDir: string,
    userDataDir: string,
    options: MarketplacePluginReconcilerOptions = {},
  ) {
    this.registry = registry;
    this.marketplaceRoot = join(agentDir, "extensions");
    this.userDataDir = userDataDir;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  async reconcile(): Promise<void> {
    await this.cleanupOrphanStaging();
    await this.cleanupLegacyTransactionJournal();
    const internal = await this.registry.getInternalSnapshot();
    const registered = new Map(internal.plugins.map((plugin) => [plugin.id, plugin]));
    for (const record of internal.plugins) {
      await this.reconcileRegistered(record);
    }
    for (const entry of await this.marketplaceEntries()) {
      if (registered.has(entry.name)) continue;
      await this.reconcileUnownedRoot(entry.name);
    }
  }

  private async reconcileRegistered(record: InstalledMarketplacePluginRecord): Promise<void> {
    try {
      await validateInstalledMarketplacePlugin(record, this.marketplaceRoot);
    } catch (error) {
      await this.markBroken(record, error);
      return;
    }
    const projection = join(record.rootPath, "index.ts");
    try {
      const info = await lstat(projection);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("projection is not a regular file");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        try {
          await writeMarketplaceProjection(record);
          this.log(`Repaired marketplace projection for ${record.id}`);
        } catch (projectionError) {
          await this.markBroken(record, projectionError);
        }
        return;
      }
      await this.markBroken(record, error);
    }
  }

  private async reconcileUnownedRoot(pluginId: string): Promise<void> {
    const rootPath = resolve(this.marketplaceRoot, pluginId);
    const ownership = await readMarketplaceRootOwnership(rootPath);
    if (ownership) {
      const uninstalledAt = this.now();
      await markMarketplaceVersionInactive(ownership.record, uninstalledAt);
      await writeMarketplaceUninstallTombstone(ownership.record, "reconcile", uninstalledAt);
      this.log(`Completed interrupted marketplace uninstall for ${pluginId}`);
      return;
    }
    await this.removeOrphanVersionRoot(rootPath, pluginId);
  }

  /**
   * Removes a version payload that was renamed into place but never committed.
   * Only a root consisting solely of an installer-owned `.versions` directory
   * with hex artifact hashes is removed; anything else is preserved.
   */
  private async removeOrphanVersionRoot(rootPath: string, pluginId: string): Promise<void> {
    try {
      const info = await lstat(rootPath);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.length !== 1 || entries[0]?.name !== VERSION_DIRECTORY || !entries[0].isDirectory()) return;
    const versionsPath = join(rootPath, VERSION_DIRECTORY);
    let versions: Dirent[];
    try {
      versions = await readdir(versionsPath, { withFileTypes: true });
    } catch {
      return;
    }
    if (versions.length === 0 || versions.some((entry) => !entry.isDirectory() || !ARTIFACT_HASH.test(entry.name))) {
      return;
    }
    for (const version of versions) {
      await rm(join(versionsPath, version.name), { recursive: true, force: true });
    }
    await rmdir(versionsPath).catch(() => undefined);
    await rmdir(rootPath).catch(() => undefined);
    this.log(`Removed uncommitted marketplace version payload for ${pluginId}`);
  }

  private async markBroken(record: InstalledMarketplacePluginRecord, error: unknown): Promise<void> {
    try {
      await this.registry.markBroken(record.id, record.artifactHash);
      await writeMarketplaceBrokenMarker({ ...record, state: "broken", enabled: false });
    } catch {
      // Broken markers are best-effort; the registry state still excludes the plugin.
    }
    this.log(
      `Marked marketplace plugin broken while reconciling ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private async cleanupOrphanStaging(): Promise<void> {
    const stagingRoot = join(this.marketplaceRoot, ".meta-agent-marketplace-staging");
    let entries: Dirent[];
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
      await rm(join(stagingRoot, entry.name), { recursive: true, force: true });
    }
    await rmdir(stagingRoot).catch(() => undefined);
  }

  /** Removes the obsolete durable apply journal directory from earlier versions. */
  private async cleanupLegacyTransactionJournal(): Promise<void> {
    const journal = join(this.userDataDir, "plugins", "transactions");
    try {
      const info = await lstat(journal);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    await rm(journal, { recursive: true, force: true });
    this.log("Removed the legacy marketplace transaction journal");
  }

  private async marketplaceEntries(): Promise<Dirent[]> {
    try {
      const entries = await readdir(this.marketplaceRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && PLUGIN_ID.test(entry.name));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
