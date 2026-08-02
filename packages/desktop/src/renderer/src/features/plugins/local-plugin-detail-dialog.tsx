import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import type { Project } from "../../../../shared/contracts.ts";
import type {
  DesktopExtensionDiagnostic,
  DesktopExtensionListEntry,
  ExtensionScope,
} from "../../../../shared/desktop-extension-contracts.ts";
import { LocalPluginDetailContent } from "./local-plugin-detail-content.tsx";

interface LocalPluginDetailDialogProps {
  plugin: DesktopExtensionListEntry;
  diagnostics: DesktopExtensionDiagnostic[];
  projects: readonly Project[];
  open: boolean;
  mutating: boolean;
  onClose(): void;
  onToggleEnabled(enabled: boolean): void;
  onScopeChange(scope: ExtensionScope, projectIds?: string[]): void;
  onRemove(): void;
}

export function LocalPluginDetailDialog({
  plugin,
  diagnostics,
  projects,
  open,
  mutating,
  onClose,
  onToggleEnabled,
  onScopeChange,
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
          projects={projects}
          mutating={mutating}
          onToggleEnabled={onToggleEnabled}
          onScopeChange={onScopeChange}
          onRemove={onRemove}
        />
      </DialogContent>
    </Dialog>
  );
}
