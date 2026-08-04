import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import type { LinkSafetyModalProps } from "streamdown";
import { useOpenWorkbenchFileInPanel, useSessionScope } from "../../session-context.tsx";

export function LinkSafetyModal({ url, isOpen, onClose }: LinkSafetyModalProps) {
  const { record } = useSessionScope();
  const openInApp = useOpenWorkbenchFileInPanel();
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogTitle>打开外部链接？</DialogTitle>
        <DialogDescription className="break-all">{url}</DialogDescription>
        <DialogFooter variant="actions">
          <DialogClose asChild>
            <Button variant="ghost">取消</Button>
          </DialogClose>
          <Button
            onClick={() => {
              void window.desktop.links
                .open(record.identity.projectId, url)
                .then((result) => {
                  if (!result.openInApp || !result.path) return;
                  // 项目内文件链接：在应用内 workbench 文件面板打开（未选中资源管理 tab 时自动打开并选中）。
                  openInApp(result.path);
                })
                .catch((error: unknown) => {
                  console.error("Failed to open link:", error);
                });
              onClose();
            }}
          >
            打开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
