import { join, resolve } from "node:path";
import {
  markMarketplaceVersionInactive,
  validateInstalledMarketplacePlugin,
  writeMarketplaceProjection,
  writeMarketplaceUninstallTombstone,
} from "./marketplace-installed-plugin.ts";
import type { MarketplacePluginReconciler } from "./marketplace-plugin-reconciler.ts";
import type { MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";
import type {
  MarketplacePluginTransaction,
  MarketplacePluginTransactionStore,
} from "./marketplace-plugin-transaction-store.ts";

export class MarketplaceMutationApplyCoordinator {
  private readonly registry: MarketplacePluginRegistry;
  private readonly transactions: MarketplacePluginTransactionStore;
  private readonly reconciler: Pick<MarketplacePluginReconciler, "reconcileTransaction">;
  private readonly marketplaceRoot: string;
  private readonly now: () => number;

  constructor(
    registry: MarketplacePluginRegistry,
    transactions: MarketplacePluginTransactionStore,
    reconciler: Pick<MarketplacePluginReconciler, "reconcileTransaction">,
    agentDir: string,
    options: { now?(): number } = {},
  ) {
    this.registry = registry;
    this.transactions = transactions;
    this.reconciler = reconciler;
    this.marketplaceRoot = join(agentDir, "extensions");
    this.now = options.now ?? Date.now;
  }

  async rollback(operationId: string): Promise<void> {
    const initial = await this.find(operationId);
    if (!initial) return;
    await this.transactions.withPluginLock(initial.pluginId, async () => {
      let transaction = await this.find(operationId);
      if (!transaction) return;
      this.assertManagedRoot(transaction);
      if (transaction.phase !== "rollback-pending") {
        if (transaction.phase !== "projection-committed") {
          throw new Error(`Marketplace mutation is not ready for apply rollback: ${operationId}`);
        }
        transaction = await this.transactions.setPhase(
          {
            ...transaction,
            removeVersionOnRollback: false,
            removeRootOnRollback: false,
          },
          "rollback-pending",
        );
      }
      const current = (await this.registry.getInternalSnapshot()).plugins.find(
        (plugin) => plugin.id === transaction.pluginId,
      );
      if (transaction.operation === "install") {
        const after = transaction.after;
        if (!after) throw new Error(`Install transaction has no after state: ${operationId}`);
        if (current?.artifactHash === after.artifactHash) {
          await this.registry.reconcilePlugin(transaction.pluginId, after.artifactHash, undefined);
        } else if (current) {
          throw new Error(`Cannot roll back install over a different artifact: ${transaction.pluginId}`);
        }
        const inactiveAt = this.now();
        await markMarketplaceVersionInactive(after, inactiveAt);
        await writeMarketplaceUninstallTombstone(after, transaction.operationId, inactiveAt, false);
        return;
      }
      const before = transaction.before;
      if (!before) throw new Error(`Marketplace mutation has no before state: ${operationId}`);
      const afterHash = transaction.after?.artifactHash;
      if (current?.artifactHash === before.artifactHash) {
        // A prior recovery attempt already restored the desired state.
      } else if (current && afterHash && current.artifactHash === afterHash) {
        await this.registry.reconcilePlugin(transaction.pluginId, afterHash, before);
      } else if (!current && transaction.operation === "uninstall") {
        await this.registry.reconcilePlugin(transaction.pluginId, before.artifactHash, before);
      } else {
        throw new Error(`Cannot restore mutation over a different registry state: ${transaction.pluginId}`);
      }
      if (transaction.operation === "update" && transaction.after) {
        await markMarketplaceVersionInactive(transaction.after, this.now());
      }
      await validateInstalledMarketplacePlugin(before, this.marketplaceRoot);
      await writeMarketplaceProjection(before);
    });
  }

  async complete(operationId: string): Promise<void> {
    const transaction = await this.find(operationId);
    if (!transaction) return;
    if (transaction.phase === "rollback-pending") {
      await this.reconciler.reconcileTransaction(operationId);
      return;
    }
    if (transaction.phase !== "projection-committed") {
      throw new Error(`Marketplace mutation cannot complete from ${transaction.phase}`);
    }
    await this.transactions.complete(transaction);
  }

  private async find(operationId: string): Promise<MarketplacePluginTransaction | undefined> {
    return (await this.transactions.list()).find((transaction) => transaction.operationId === operationId);
  }

  private assertManagedRoot(transaction: MarketplacePluginTransaction): void {
    if (resolve(transaction.rootPath) !== resolve(this.marketplaceRoot, transaction.pluginId)) {
      throw new Error(`Marketplace apply transaction root is outside the managed root: ${transaction.operationId}`);
    }
  }
}
