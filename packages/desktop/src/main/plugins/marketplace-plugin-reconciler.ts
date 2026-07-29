import type { Dirent } from "node:fs";
import { readdir, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  markMarketplaceVersionInactive,
  removeMarketplaceVersionIfOwned,
  validateInstalledMarketplacePlugin,
  writeMarketplaceBrokenMarker,
  writeMarketplaceProjection,
  writeMarketplaceUninstallTombstone,
} from "./marketplace-installed-plugin.ts";
import type { InstalledMarketplacePluginRecord, MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";
import type {
  MarketplacePluginTransaction,
  MarketplacePluginTransactionStore,
} from "./marketplace-plugin-transaction-store.ts";

interface MarketplacePluginReconcilerOptions {
  now?(): number;
  log?(message: string): void;
}

export class MarketplacePluginReconciler {
  private readonly registry: MarketplacePluginRegistry;
  private readonly transactions: MarketplacePluginTransactionStore;
  private readonly marketplaceRoot: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    registry: MarketplacePluginRegistry,
    transactions: MarketplacePluginTransactionStore,
    agentDir: string,
    options: MarketplacePluginReconcilerOptions = {},
  ) {
    this.registry = registry;
    this.transactions = transactions;
    this.marketplaceRoot = join(agentDir, "extensions");
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  async reconcile(): Promise<void> {
    for (const transaction of await this.transactions.list()) {
      await this.reconcileTransaction(transaction.operationId);
    }
    await this.cleanupOrphanStaging();
  }

  async reconcileTransaction(operationId: string): Promise<void> {
    const transaction = (await this.transactions.list()).find((entry) => entry.operationId === operationId);
    if (!transaction) return;
    await this.transactions.withPluginLock(transaction.pluginId, async () => {
      assertTransactionPaths(transaction, this.marketplaceRoot);
      if (transaction.operation === "install") await this.reconcileInstall(transaction);
      else if (transaction.operation === "update") await this.reconcileUpdate(transaction);
      else await this.reconcileUninstall(transaction);
    });
  }

  private async reconcileInstall(transaction: MarketplacePluginTransaction): Promise<void> {
    const after = transaction.after;
    if (!after) throw new Error(`Install transaction has no after record: ${transaction.operationId}`);
    const current = await this.currentRecord(transaction.pluginId);
    if (transaction.phase === "rollback-pending") {
      if (transaction.removeVersionOnRollback || transaction.removeRootOnRollback) {
        await this.cleanupInstallFiles(transaction);
        await this.transactions.complete(transaction);
        this.log(`Removed uncommitted marketplace install transaction ${transaction.operationId}`);
        return;
      }
      if (current?.artifactHash === after.artifactHash) {
        await this.registry.reconcilePlugin(transaction.pluginId, after.artifactHash, transaction.before);
      } else if (current) {
        throw new Error(`Cannot roll back transaction over a different installed artifact: ${transaction.pluginId}`);
      }
      const uninstalledAt = this.now();
      await markMarketplaceVersionInactive(after, uninstalledAt);
      await writeMarketplaceUninstallTombstone(after, transaction.operationId, uninstalledAt);
      await this.cleanupInstallFiles(transaction);
      await this.transactions.complete(transaction);
      this.log(`Rolled back marketplace install transaction ${transaction.operationId}`);
      return;
    }
    if (!current) {
      await this.cleanupInstallFiles(transaction);
      await this.transactions.complete(transaction);
      this.log(`Removed uncommitted marketplace install transaction ${transaction.operationId}`);
      return;
    }
    if (current.artifactHash !== after.artifactHash) {
      throw new Error(`Marketplace install transaction conflicts with installed artifact: ${transaction.pluginId}`);
    }
    try {
      await validateInstalledMarketplacePlugin(after, this.marketplaceRoot);
    } catch (error) {
      const brokenRecord: InstalledMarketplacePluginRecord = { ...after, state: "broken", enabled: false };
      await this.registry.markBroken(after.id, after.artifactHash);
      await writeMarketplaceBrokenMarker(brokenRecord);
      await this.transactions.complete(transaction);
      this.log(
        `Marked marketplace plugin broken while reconciling ${transaction.operationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await writeMarketplaceProjection(after);
    const projected = await this.transactions.setPhase(transaction, "projection-committed");
    await this.transactions.complete(projected);
    this.log(`Completed marketplace install transaction ${transaction.operationId}`);
  }

  private async reconcileUpdate(transaction: MarketplacePluginTransaction): Promise<void> {
    const before = transaction.before;
    const after = transaction.after;
    if (!before || !after) throw new Error(`Update transaction is incomplete: ${transaction.operationId}`);
    const current = await this.currentRecord(transaction.pluginId);
    if (transaction.phase === "rollback-pending") {
      if (current?.artifactHash === after.artifactHash) {
        await this.registry.reconcilePlugin(transaction.pluginId, after.artifactHash, before);
      } else if (current?.artifactHash !== before.artifactHash) {
        throw new Error(`Cannot roll back update over a different artifact: ${transaction.pluginId}`);
      }
      await validateInstalledMarketplacePlugin(before, this.marketplaceRoot);
      await writeMarketplaceProjection(before);
      await this.cleanupInstallFiles(transaction);
      await this.transactions.complete(transaction);
      this.log(`Rolled back marketplace update transaction ${transaction.operationId}`);
      return;
    }
    if (current?.artifactHash === before.artifactHash) {
      await this.cleanupInstallFiles(transaction);
      await writeMarketplaceProjection(before);
      await this.transactions.complete(transaction);
      this.log(`Removed uncommitted marketplace update transaction ${transaction.operationId}`);
      return;
    }
    if (current?.artifactHash !== after.artifactHash) {
      throw new Error(`Marketplace update transaction conflicts with installed artifact: ${transaction.pluginId}`);
    }
    await markMarketplaceVersionInactive(before, this.now());
    try {
      await validateInstalledMarketplacePlugin(after, this.marketplaceRoot);
    } catch (error) {
      const brokenRecord: InstalledMarketplacePluginRecord = { ...after, state: "broken", enabled: false };
      await this.registry.markBroken(after.id, after.artifactHash);
      await writeMarketplaceBrokenMarker(brokenRecord);
      await this.transactions.complete(transaction);
      this.log(
        `Marked updated marketplace plugin broken while reconciling ${transaction.operationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await writeMarketplaceProjection(after);
    const projected = await this.transactions.setPhase(transaction, "projection-committed");
    await this.transactions.complete(projected);
    this.log(`Completed marketplace update transaction ${transaction.operationId}`);
  }

  private async reconcileUninstall(transaction: MarketplacePluginTransaction): Promise<void> {
    const before = transaction.before;
    if (!before) throw new Error(`Uninstall transaction has no before record: ${transaction.operationId}`);
    const current = await this.currentRecord(transaction.pluginId);
    if (transaction.phase === "rollback-pending") {
      if (!current) await this.registry.reconcilePlugin(before.id, before.artifactHash, before);
      else if (current.artifactHash !== before.artifactHash) {
        throw new Error(`Cannot restore uninstall over a different artifact: ${transaction.pluginId}`);
      }
      await validateInstalledMarketplacePlugin(before, this.marketplaceRoot);
      await writeMarketplaceProjection(before);
      await this.transactions.complete(transaction);
      this.log(`Rolled back marketplace uninstall transaction ${transaction.operationId}`);
      return;
    }
    if (current) {
      if (current.artifactHash !== before.artifactHash) {
        throw new Error(`Marketplace uninstall transaction conflicts with installed artifact: ${transaction.pluginId}`);
      }
      await this.transactions.complete(transaction);
      this.log(`Discarded uncommitted marketplace uninstall transaction ${transaction.operationId}`);
      return;
    }
    const uninstalledAt = this.now();
    await markMarketplaceVersionInactive(before, uninstalledAt);
    await writeMarketplaceUninstallTombstone(before, transaction.operationId, uninstalledAt);
    const projected = await this.transactions.setPhase(transaction, "projection-committed");
    await this.transactions.complete(projected);
    this.log(`Completed marketplace uninstall transaction ${transaction.operationId}`);
  }

  private async cleanupInstallFiles(transaction: MarketplacePluginTransaction): Promise<void> {
    if (transaction.stagingPath) await rm(transaction.stagingPath, { recursive: true, force: true });
    if (transaction.versionPath && transaction.removeVersionOnRollback && transaction.after) {
      const removed = await removeMarketplaceVersionIfOwned(transaction.after, this.marketplaceRoot);
      if (!removed) this.log(`Preserved unverified marketplace version path ${transaction.versionPath}`);
    }
    if (transaction.removeRootOnRollback) {
      await rmdir(join(transaction.rootPath, ".versions")).catch(() => undefined);
      await rmdir(transaction.rootPath).catch(() => undefined);
    }
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

  private async currentRecord(pluginId: string): Promise<InstalledMarketplacePluginRecord | undefined> {
    return (await this.registry.getInternalSnapshot()).plugins.find((plugin) => plugin.id === pluginId);
  }
}

function assertTransactionPaths(transaction: MarketplacePluginTransaction, marketplaceRoot: string): void {
  const expectedRoot = resolve(marketplaceRoot, transaction.pluginId);
  if (resolve(transaction.rootPath) !== expectedRoot) {
    throw new Error(`Marketplace transaction root is outside the managed root: ${transaction.operationId}`);
  }
  const artifactHash = transaction.after?.artifactHash ?? transaction.before?.artifactHash;
  if (
    transaction.versionPath &&
    resolve(transaction.versionPath) !== resolve(expectedRoot, ".versions", artifactHash ?? "")
  ) {
    throw new Error(`Marketplace transaction version path is invalid: ${transaction.operationId}`);
  }
  const expectedStagingRoot = resolve(marketplaceRoot, ".meta-agent-marketplace-staging");
  const stagingName = transaction.stagingPath ? basename(resolve(transaction.stagingPath)) : undefined;
  if (
    transaction.stagingPath &&
    (dirname(resolve(transaction.stagingPath)) !== expectedStagingRoot ||
      !stagingName?.startsWith(`${transaction.pluginId}-`) ||
      !/^[a-zA-Z0-9._-]+$/.test(stagingName))
  ) {
    throw new Error(`Marketplace transaction staging path is invalid: ${transaction.operationId}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
