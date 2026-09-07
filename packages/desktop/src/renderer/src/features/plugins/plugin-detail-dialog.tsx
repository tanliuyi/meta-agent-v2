import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogHeader } from "@renderer/shared/ui/dialog-header";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import type { CodexPluginSummary } from "../../../../shared/codex-plugin-contracts.ts";
import { PluginIcon } from "../../components/chat/plugin-icon.tsx";

interface PluginDetailDialogProps {
  plugin?: CodexPluginSummary;
  open: boolean;
  onClose(): void;
}

/** Compact Codex metadata dialog retained for embedded plugin surfaces. */
export function PluginDetailDialog({ plugin, open, onClose }: PluginDetailDialogProps) {
  if (!plugin) return null;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="plugin-marketplace-detail-dialog w-[min(60rem,calc(100vw-48px))] max-w-none gap-0 p-0 sm:max-w-none max-[480px]:w-[calc(100vw-16px)] max-[480px]:max-h-[calc(100dvh-16px)]">
        <DialogHeader className="plugin-marketplace-detail-header">
          <div className="plugin-marketplace-detail-identity">
            <div className="plugin-marketplace-detail-icon" aria-hidden="true">
              <PluginIcon name={plugin.displayName} className="size-11" />
            </div>
            <div>
              <DialogTitle>{plugin.displayName}</DialogTitle>
              <div className="plugin-marketplace-detail-publisher">
                <span>{plugin.developerName}</span>
                <span className="plugin-marketplace-badge" data-tone={plugin.installed ? "success" : "neutral"}>
                  {plugin.installed ? "已安装" : "未安装"}
                </span>
              </div>
            </div>
          </div>
          <DialogDescription>{plugin.description}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
