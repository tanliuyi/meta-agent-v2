import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { Input } from "@renderer/shared/ui/input";
import { useState } from "react";

interface AddProviderDialogProps {
  knownProviders: Array<{ id: string; displayName: string }>;
  onConfirm(key: string): void;
  onCancel(): void;
}

/** Small dialog to enter a key for a new custom provider. */
export function AddProviderDialog({ knownProviders, onConfirm, onCancel }: AddProviderDialogProps) {
  const [key, setKey] = useState("");
  const suggestion = key
    ? knownProviders.find(
        (kp) =>
          kp.id.toLowerCase().includes(key.toLowerCase()) || kp.displayName.toLowerCase().includes(key.toLowerCase()),
      )
    : undefined;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <h2 className="text-lg font-semibold mb-2">新增 Provider</h2>
        <p className="text-sm text-muted-foreground mb-4">
          输入自定义 Provider 的唯一标识。如需配置内置 Provider，在列表中选择后编辑即可。
        </p>
        <div className="providers-form-grid">
          <label>
            <span>Provider Key</span>
            <Input
              value={key}
              placeholder="例如 my-provider"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && key.trim()) onConfirm(key.trim());
              }}
            />
          </label>
          {suggestion && (
            <p className="providers-form-hint">
              内置 provider "{suggestion.displayName}" ({suggestion.id}) 已在列表中，可直接编辑。
            </p>
          )}
        </div>
        <DialogFooter variant="actions" className="mt-4">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={!key.trim()} onClick={() => onConfirm(key.trim())}>
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
