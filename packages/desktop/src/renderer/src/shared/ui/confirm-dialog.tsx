import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

/** 组合受控 Dialog 与破坏性确认操作，关闭状态始终由调用方持有。 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "删除",
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <div className="mt-3 flex justify-end gap-2">
          <DialogClose asChild>
            <Button ref={cancelRef} variant="ghost">
              取消
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
