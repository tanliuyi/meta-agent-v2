import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";

interface ShellRuntimeBlockerProps {
  status: ShellRuntimeStatus;
  progress: ShellRuntimeProgress | null;
  installing: boolean;
  choosing: boolean;
  onInstall(): Promise<void>;
  onChoose(): Promise<void>;
}

export function ShellRuntimeBlocker({
  status,
  progress,
  installing,
  choosing,
  onInstall,
  onChoose,
}: ShellRuntimeBlockerProps) {
  const busy = installing || choosing;
  const failed = progress?.phase === "error" || status.state === "invalid";
  const message = progress?.phase === "error" ? (progress.error ?? progress.message) : status.message;

  return (
    <AlertDialogPrimitive.Root open>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="shell-runtime-overlay" />
        <AlertDialogPrimitive.Content className="shell-runtime-blocker">
          <AlertDialogPrimitive.Title className="shell-runtime-title">缺少 Git Bash</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="sr-only">
            选择已有 Git Bash 或自动安装
          </AlertDialogPrimitive.Description>
          <div className="shell-runtime-list">
            <div className="shell-runtime-item">
              <div className="shell-runtime-item-copy">
                <strong>Git Bash</strong>
                <span className={failed ? "shell-runtime-error" : "shell-runtime-message"} aria-live="polite">
                  {message}
                </span>
                {progress && progress.phase !== "error" ? (
                  <div className="shell-runtime-progress">
                    <progress max={100} value={progress.percent} aria-label="Git Bash 安装进度" />
                    <span>{progress.percent}%</span>
                  </div>
                ) : null}
              </div>
              <div className="shell-runtime-item-actions">
                <button
                  className="shell-runtime-button secondary"
                  type="button"
                  onClick={() => void onChoose()}
                  disabled={busy}
                >
                  <FolderOpen aria-hidden="true" />
                  {choosing ? "检查中" : "选择"}
                </button>
                <button
                  className="shell-runtime-button primary"
                  type="button"
                  onClick={() => void onInstall()}
                  disabled={busy}
                >
                  <Download aria-hidden="true" />
                  {installing ? "安装中" : "安装"}
                </button>
              </div>
            </div>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
