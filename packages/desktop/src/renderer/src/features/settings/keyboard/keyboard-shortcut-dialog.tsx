import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import {
  formatKeyboardShortcut,
  isSafeKeyboardShortcut,
  type KeyboardShortcut,
  keyboardShortcutFromEvent,
  keyboardShortcutKey,
} from "@renderer/state/keyboard-shortcuts";
import Keyboard from "lucide-react/dist/esm/icons/keyboard.mjs";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";

export function KeyboardShortcutDialog({
  commandTitle,
  initialBinding,
  reservedBindings,
  open,
  onOpenChange,
  onSave,
}: {
  commandTitle: string;
  initialBinding: KeyboardShortcut | null;
  reservedBindings: ReadonlyMap<string, string>;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(binding: KeyboardShortcut): void;
}) {
  const [binding, setBinding] = useState<KeyboardShortcut | null>(initialBinding);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setBinding(initialBinding);
    setError(null);
    requestAnimationFrame(() => recorderRef.current?.focus());
  }, [initialBinding, open]);

  const record = (event: ReactKeyboardEvent): void => {
    const noCommandModifier = !event.ctrlKey && !event.metaKey && !event.altKey;
    const plainEscape = event.key === "Escape" && noCommandModifier && !event.shiftKey;
    const focusNavigation = event.key === "Tab" && noCommandModifier;
    if (focusNavigation || plainEscape) return;
    event.preventDefault();
    event.stopPropagation();
    const next = keyboardShortcutFromEvent(event.nativeEvent, window.desktop.platform);
    if (!next) return;
    const conflict = reservedBindings.get(keyboardShortcutKey(next));
    setBinding(next);
    setError(
      !isSafeKeyboardShortcut(next) ? "请使用主修饰键、Alt 或功能键" : conflict ? `已分配给“${conflict}”` : null,
    );
  };

  const bindingLabel = binding ? formatKeyboardShortcut(binding, window.desktop.platform) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="keyboard-shortcut-dialog">
        <div>
          <DialogTitle>编辑快捷键</DialogTitle>
          <DialogDescription>{commandTitle}</DialogDescription>
        </div>
        <button
          ref={recorderRef}
          type="button"
          className="keyboard-shortcut-recorder"
          aria-label={bindingLabel ? `已录制 ${bindingLabel}` : "录制快捷键"}
          onKeyDown={record}
        >
          <Keyboard aria-hidden="true" />
          <span>{bindingLabel ?? "按下快捷键"}</span>
        </button>
        <p className="keyboard-shortcut-dialog-status" data-error={error ? true : undefined} role="status">
          {error ?? (bindingLabel ? `${bindingLabel} 已录制` : "等待键盘输入")}
        </p>
        <DialogFooter variant="actions">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!binding || Boolean(error)}
            onClick={() => {
              if (!binding || error) return;
              onSave(binding);
              onOpenChange(false);
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
