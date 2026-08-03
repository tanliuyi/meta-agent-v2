import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogHeader } from "@renderer/shared/ui/dialog-header";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.mjs";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import type { Project } from "../../../../shared/contracts.ts";
import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginScope,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";
import { PluginDetailActions } from "./plugin-detail-actions.tsx";
import { PluginDetailContent } from "./plugin-detail-content.tsx";
import { PluginDetailStatusBadges } from "./plugin-detail-status.tsx";

export { pluginActionConfirmation } from "./plugin-detail-content.tsx";

interface PluginDetailDialogProps {
  plugin?: MarketplacePluginSummary;
  installed?: InstalledMarketplacePluginSummary;
  marketplaceId?: string;
  projects: readonly Project[];
  open: boolean;
  mutationPending: boolean;
  installing: boolean;
  updating: boolean;
  uninstalling: boolean;
  onClose(): void;
  onInstall(plugin: MarketplacePluginSummary): void;
  onUpdate(plugin: MarketplacePluginSummary): void;
  onUninstall(id: string): void;
  onSetScope(id: string, scope: MarketplacePluginScope, projectIds?: string[]): void;
}

/** Compatibility wrapper retained for callers that still render the legacy modal. */
export function PluginDetailDialog({
  plugin,
  installed,
  marketplaceId,
  projects,
  open,
  mutationPending,
  installing,
  updating,
  uninstalling,
  onClose,
  onInstall,
  onUpdate,
  onUninstall,
  onSetScope,
}: PluginDetailDialogProps) {
  if (!plugin && !installed) return null;
  const name = plugin?.name ?? installed!.displayName;
  const publisher = plugin?.publisher.displayName ?? installed!.marketplaceId;
  const description = plugin?.description ?? "该插件已安装，但当前市场目录中没有对应条目。";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="plugin-marketplace-detail-dialog w-[min(60rem,calc(100vw-48px))] max-w-none gap-0 p-0 sm:max-w-none max-[480px]:w-[calc(100vw-16px)] max-[480px]:max-h-[calc(100dvh-16px)]">
        <DialogHeader className="plugin-marketplace-detail-header">
          <div className="plugin-marketplace-detail-identity">
            <div className="plugin-marketplace-detail-icon" aria-hidden="true">
              <Blocks />
            </div>
            <div>
              <DialogTitle>{name}</DialogTitle>
              <div className="plugin-marketplace-detail-publisher">
                <span>{publisher}</span>
                {plugin?.publisher.verified ? (
                  <span className="plugin-marketplace-verified">
                    <BadgeCheck aria-hidden="true" />
                    已验证
                  </span>
                ) : null}
                <PluginDetailStatusBadges plugin={plugin} installed={installed} />
              </div>
            </div>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <PluginDetailActions
          plugin={plugin}
          installed={installed}
          mutationPending={mutationPending}
          installing={installing}
          updating={updating}
          uninstalling={uninstalling}
          onInstall={onInstall}
          onUpdate={onUpdate}
          onUninstall={onUninstall}
        />
        <PluginDetailContent
          plugin={plugin}
          installed={installed}
          marketplaceId={marketplaceId}
          projects={projects}
          mutationPending={mutationPending}
          onSetScope={onSetScope}
        />
      </DialogContent>
    </Dialog>
  );
}
