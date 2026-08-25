import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  isMarketplacePluginOwned,
  MarketplacePluginRootMismatchError,
  marketplaceOwnershipMatchesRecord,
  marketplaceRecordBindsToRoot,
  markMarketplaceVersionInactive,
  readMarketplaceRootOwnership,
  validateInstalledMarketplacePlugin,
  writeMarketplaceBrokenMarker,
  writeMarketplaceProjection,
  writeMarketplaceUninstallTombstone,
} from "./marketplace-installed-plugin.ts";
import { withMarketplacePluginLock } from "./marketplace-plugin-lock.ts";
import type { InstalledMarketplacePluginRecord, MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";

interface MarketplacePluginReconcilerOptions {
  now?(): number;
  log?(message: string): void;
  /** Pi 自动发现目录 `agentDir/extensions`：旧版本托管根，仅用于安全完成中断卸载。 */
  legacyRoot?: string;
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
  private readonly lockDirectory: string;
  private readonly userDataDir: string;
  private readonly legacyRoot: string | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    registry: MarketplacePluginRegistry,
    marketplaceRoot: string,
    userDataDir: string,
    options: MarketplacePluginReconcilerOptions = {},
  ) {
    this.registry = registry;
    this.marketplaceRoot = marketplaceRoot;
    this.lockDirectory = join(userDataDir, "plugins", "locks");
    this.userDataDir = userDataDir;
    this.legacyRoot = options.legacyRoot;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  async reconcile(): Promise<void> {
    await this.cleanupOrphanStaging();
    await this.cleanupLegacyTransactionJournal();
    const internal = await this.registry.getInternalSnapshot();
    for (const record of internal.plugins) {
      await withMarketplacePluginLock(this.lockDirectory, record.id, async () => {
        const latest = (await this.registry.getInternalSnapshot()).plugins.find((plugin) => plugin.id === record.id);
        if (latest) await this.reconcileRegistered(latest);
      });
    }
    for (const entry of await this.marketplaceEntries()) {
      await withMarketplacePluginLock(this.lockDirectory, entry.name, async () => {
        const registered = (await this.registry.getInternalSnapshot()).plugins.some(
          (plugin) => plugin.id === entry.name,
        );
        if (!registered) await this.reconcileUnownedRoot(entry.name);
      });
    }
    await this.reconcileLegacyRoot();
  }

  private async reconcileRegistered(record: InstalledMarketplacePluginRecord): Promise<void> {
    try {
      await validateInstalledMarketplacePlugin(record, this.marketplaceRoot);
    } catch (error) {
      if (error instanceof MarketplacePluginRootMismatchError) {
        try {
          if (await this.migrateLegacyPlugin(record)) return;
        } catch (migrationError) {
          await this.markBroken(record, migrationError);
          return;
        }
        await this.markBroken(
          record,
          new Error(`Marketplace plugin is outside the Desktop managed root: ${record.id}`),
        );
        return;
      }
      if (record.state !== "broken") await this.markBroken(record, error);
      return;
    }
    if (record.state === "broken") {
      const repaired: InstalledMarketplacePluginRecord = {
        ...record,
        state: "installed",
        enabled: true,
      };
      try {
        await writeMarketplaceProjection(repaired);
        await this.registry.markInstalled(record.id, record.artifactHash);
        this.log(`Repaired marketplace plugin ${record.id}`);
      } catch (error) {
        await this.markBroken(repaired, error);
      }
      return;
    }
    const ownership = await readMarketplaceRootOwnership(record.rootPath);
    if (ownership?.record.artifactHash !== record.artifactHash) {
      try {
        await writeMarketplaceProjection(record);
        this.log(`Repaired marketplace projection for ${record.id}`);
      } catch (error) {
        await this.markBroken(record, error);
      }
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
      // 只信任描述本目录的 ownership：record 指向其他目录的 marker 不得驱动任何写入。
      if (!marketplaceRecordBindsToRoot(ownership.record, rootPath, pluginId)) {
        this.log(`Skipped marketplace ownership record that does not belong to ${pluginId}`);
        return;
      }
      try {
        await validateInstalledMarketplacePlugin(ownership.record, this.marketplaceRoot);
      } catch {
        this.log(`Skipped marketplace uninstall cleanup for ${pluginId}: payload is not structurally owned`);
        return;
      }
      const uninstalledAt = this.now();
      await markMarketplaceVersionInactive(ownership.record, uninstalledAt);
      await writeMarketplaceUninstallTombstone(ownership.record, "reconcile", uninstalledAt);
      this.log(`Completed interrupted marketplace uninstall for ${pluginId}`);
      return;
    }
    await this.removeOrphanVersionRoot(rootPath, pluginId);
  }

  /**
   * 完成托管根迁移前崩溃的中断卸载：显式扫描旧 `agentDir/extensions` 根。
   *
   * 旧版本卸载先删 registry 再删 projection；若在两者之间崩溃，升级后新托管根
   * 里没有该插件的注册与目录，旧 projection 会留在 Pi 自动发现目录继续执行。
   * 只有当 marker 记录绑定到该目录、且版本 payload 仍能完整校验（结构上确属
   * Marketplace 产物）时才补完卸载；未知/外来内容一律不动。
   */
  private async reconcileLegacyRoot(): Promise<void> {
    const legacyRoot = this.legacyRoot;
    if (!legacyRoot) return;
    if (resolve(legacyRoot) === resolve(this.marketplaceRoot)) return;
    let entries: Dirent[];
    try {
      entries = await readdir(legacyRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PLUGIN_ID.test(entry.name)) continue;
      await withMarketplacePluginLock(this.lockDirectory, entry.name, async () => {
        const registered = (await this.registry.getInternalSnapshot()).plugins.some(
          (plugin) => plugin.id === entry.name,
        );
        if (registered) return;
        const rootPath = resolve(legacyRoot, entry.name);
        const ownership = await readMarketplaceRootOwnership(rootPath);
        if (!ownership || !marketplaceRecordBindsToRoot(ownership.record, rootPath, entry.name)) return;
        try {
          await validateInstalledMarketplacePlugin(ownership.record, legacyRoot);
        } catch {
          this.log(`Skipped legacy marketplace uninstall cleanup for ${entry.name}: payload is not structurally owned`);
          return;
        }
        const uninstalledAt = this.now();
        await markMarketplaceVersionInactive(ownership.record, uninstalledAt);
        await writeMarketplaceUninstallTombstone(ownership.record, "reconcile-legacy", uninstalledAt);
        this.log(`Completed legacy interrupted marketplace uninstall for ${entry.name}`);
      });
    }
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
      await rm(join(versionsPath, version.name), {
        recursive: true,
        force: true,
      });
    }
    await rmdir(versionsPath).catch(() => undefined);
    await rmdir(rootPath).catch(() => undefined);
    this.log(`Removed uncommitted marketplace version payload for ${pluginId}`);
  }

  private async migrateLegacyPlugin(record: InstalledMarketplacePluginRecord): Promise<boolean> {
    const targetRoot = resolve(this.marketplaceRoot, record.id);
    const entryRelative = relative(record.rootPath, record.entryPath);
    if (!entryRelative || entryRelative.startsWith("..") || isAbsolute(entryRelative)) return false;
    const migrated: InstalledMarketplacePluginRecord = {
      ...record,
      rootPath: targetRoot,
      entryPath: resolve(targetRoot, entryRelative),
      state: "installed",
      enabled: record.state === "broken" ? true : record.enabled,
    };
    const [sourceOwnership, targetOwnership] = await Promise.all([
      readMarketplaceRootOwnership(record.rootPath),
      readMarketplaceRootOwnership(targetRoot),
    ]);
    const sourceOwned = marketplaceOwnershipMatchesRecord(sourceOwnership, record);
    const targetRecoverable =
      marketplaceOwnershipMatchesRecord(targetOwnership, record) ||
      marketplaceOwnershipMatchesRecord(targetOwnership, migrated);
    if (sourceOwned) await validateInstalledMarketplacePlugin(record, dirname(record.rootPath));
    let targetExists = await pathExists(targetRoot);
    if (targetExists) {
      try {
        await validateInstalledMarketplacePlugin(migrated, this.marketplaceRoot);
      } catch (error) {
        if (!sourceOwned || !marketplaceOwnershipMatchesRecord(targetOwnership, record)) throw error;
        await rm(targetRoot, { recursive: true, force: true });
        targetExists = false;
      }
    }
    if ((targetExists && !targetRecoverable) || (!targetExists && !sourceOwned)) return false;

    if (!targetExists) {
      await mkdir(this.marketplaceRoot, { recursive: true, mode: 0o700 });
      try {
        await rename(record.rootPath, targetRoot);
      } catch (error) {
        if (!isNodeError(error, "EXDEV")) throw error;
        await cp(record.rootPath, targetRoot, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
        });
      }
    }

    await validateInstalledMarketplacePlugin(migrated, this.marketplaceRoot);
    await writeMarketplaceProjection(migrated);
    await validateInstalledMarketplacePlugin(migrated, this.marketplaceRoot);
    if (await isMarketplacePluginOwned(record)) {
      await rm(record.rootPath, { recursive: true, force: true });
    }
    await this.registry.reconcilePlugin(record.id, record.artifactHash, migrated);
    this.log(`Migrated marketplace plugin ${record.id} into the Desktop managed root`);
    return true;
  }

  private async markBroken(record: InstalledMarketplacePluginRecord, error: unknown): Promise<void> {
    if (record.state !== "broken") await this.registry.markBroken(record.id, record.artifactHash);
    try {
      if (await isMarketplacePluginOwned(record)) {
        await writeMarketplaceBrokenMarker({ ...record, state: "broken", enabled: false });
      }
    } catch {
      // The registry state is authoritative; cleanup outside the managed root is best-effort.
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
      const entries = await readdir(this.marketplaceRoot, {
        withFileTypes: true,
      });
      return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && PLUGIN_ID.test(entry.name));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
  }
}

function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    },
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
