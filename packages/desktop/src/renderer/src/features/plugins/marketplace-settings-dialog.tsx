import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogHeader } from "@renderer/shared/ui/dialog-header";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { MarketplaceEndpointSettings } from "./marketplace-endpoint-settings.tsx";

interface MarketplaceSettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(): void;
}

export function MarketplaceSettingsDialog({ open, onOpenChange, onSaved }: MarketplaceSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="plugin-marketplace-settings-dialog">
        <DialogHeader>
          <DialogTitle>插件中心设置</DialogTitle>
          <DialogDescription>配置插件市场服务地址和签名密钥。</DialogDescription>
        </DialogHeader>
        <MarketplaceEndpointSettings onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}
