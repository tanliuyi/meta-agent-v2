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
  onOpenChange?(open: boolean): void;
  onCancel?(): void;
  onConfirm(): void;
}

/** Controlled confirmation dialog with separate confirm and cancel effects. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "删除",
  onOpenChange,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (!nextOpen) onCancel?.();
  };

  const handleConfirm = () => {
    onConfirm();
    onOpenChange?.(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
          <Button variant="destructive" onClick={handleConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
