import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import type {
  DesktopExtensionDiagnostic,
  DesktopExtensionListEntry,
} from "../../../../shared/desktop-extension-contracts.ts";
import { LocalPluginDetailContent } from "./local-plugin-detail-content.tsx";

interface LocalPluginDetailDialogProps {
  plugin: DesktopExtensionListEntry;
  diagnostics: DesktopExtensionDiagnostic[];
  open: boolean;
  mutating: boolean;
  onClose(): void;
  onToggleEnabled(enabled: boolean): void;
  onRemove(): void;
}

export function LocalPluginDetailDialog({
  plugin,
  diagnostics,
  open,
  mutating,
  onClose,
  onToggleEnabled,
  onRemove,
}: LocalPluginDetailDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="plugin-marketplace-detail-dialog w-[min(60rem,calc(100vw-48px))] max-w-none gap-0 p-0 sm:max-w-none max-[480px]:w-[calc(100vw-16px)] max-[480px]:max-h-[calc(100dvh-16px)]">
        <DialogTitle className="sr-only">{plugin.displayName}</DialogTitle>
        <DialogDescription className="sr-only">{plugin.displayPath ?? "本地扩展入口"}</DialogDescription>
        <LocalPluginDetailContent
          plugin={plugin}
          diagnostics={diagnostics}
          mutating={mutating}
          onToggleEnabled={onToggleEnabled}
          onRemove={onRemove}
        />
      </DialogContent>
    </Dialog>
  );
}
