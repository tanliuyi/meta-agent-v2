import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { NodeRuntimeProgress, NodeRuntimeStatus } from "../../../../shared/desktop-api.ts";

interface NodeRuntimeBlockerProps {
  status: NodeRuntimeStatus;
  progress: NodeRuntimeProgress | null;
  installing: boolean;
  onInstall(): Promise<void>;
}

/** 呈现 sidecar 的 Node.js 前置条件；安装状态和 IPC 生命周期由 DesktopApp 持有。 */
export function NodeRuntimeBlocker({ status, progress, installing, onInstall }: NodeRuntimeBlockerProps) {
  return (
    <AlertDialogPrimitive.Root open>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="node-runtime-overlay" />
        <AlertDialogPrimitive.Content className="node-runtime-blocker">
          <div>
            <AlertDialogPrimitive.Title className="node-runtime-title">
              需要 Node.js 才能运行 Desktop sidecar
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description asChild>
              <div aria-live="polite">
                <p>{progress?.message ?? status.message}</p>
                <small>安装完成后 Desktop 会自动重启并重新连接 Pi。</small>
              </div>
            </AlertDialogPrimitive.Description>
          </div>
          <div className="node-runtime-actions">
            <button type="button" onClick={() => void onInstall()} disabled={installing}>
              {installing ? `安装中 ${progress?.percent ?? 0}%` : "一键安装 Node.js"}
            </button>
            {progress && progress.phase !== "error" ? (
              <progress max={100} value={progress.percent} aria-label="Node.js 安装进度" />
            ) : null}
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
