import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { useRef, useState } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onOpenChange?(open: boolean): void;
  onCancel?(): void;
  /** 可返回 Promise；Dialog 会等待其完成（成功）才关闭，失败时保持打开。 */
  onConfirm(): void | Promise<void>;
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
  const [pending, setPending] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && pending) return;
    onOpenChange?.(nextOpen);
    if (!nextOpen) onCancel?.();
  };

  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange?.(false);
    } finally {
      setPending(false);
    }
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
        <DialogFooter variant="actions">
          <DialogClose asChild>
            <Button ref={cancelRef} variant="ghost" disabled={pending}>
              取消
            </Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void handleConfirm().catch(() => undefined)}>
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
