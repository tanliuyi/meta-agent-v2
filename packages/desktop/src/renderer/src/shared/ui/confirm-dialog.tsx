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

/**
 * 组合受控 Dialog 与破坏性确认操作，关闭状态始终由调用方持有。
 *
 * 点击确认按钮时先关闭 Dialog（播放关闭动画），
 * 动画完成后再执行 onConfirm，避免页面内容在关闭动画期间变化导致跳动。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "删除",
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmPendingRef = useRef(false);
  const pendingOnConfirmRef = useRef(onConfirm);

  const handleConfirm = () => {
    confirmPendingRef.current = true;
    // 捕获当前 onConfirm，防止后续父组件重渲染时闭包中的状态变量被清空
    pendingOnConfirmRef.current = onConfirm;
    // 先触发关闭动画
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        // 关闭动画完成后才执行确认动作
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (confirmPendingRef.current) {
            confirmPendingRef.current = false;
            pendingOnConfirmRef.current();
          }
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
