import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import type { LinkSafetyModalProps } from "streamdown";

export function LinkSafetyModal({ url, isOpen, onClose }: LinkSafetyModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogTitle>打开外部链接？</DialogTitle>
        <DialogDescription className="break-all">{url}</DialogDescription>
        <div className="mt-3 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost">取消</Button>
          </DialogClose>
          <Button
            onClick={() => {
              void window.desktop.links.open(url).catch((error: unknown) => {
                console.error("Failed to open link:", error);
              });
              onClose();
            }}
          >
            继续打开
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
