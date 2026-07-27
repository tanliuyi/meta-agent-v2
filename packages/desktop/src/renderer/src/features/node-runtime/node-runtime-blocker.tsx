import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { NodeRuntimeProgress, NodeRuntimeStatus, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";

interface NodeRuntimeBlockerProps {
  kind: "node" | "shell";
  status: NodeRuntimeStatus | ShellRuntimeStatus;
  progress: NodeRuntimeProgress | null;
  installing: boolean;
  onInstall(): Promise<void>;
}

/** 呈现 sidecar 的 runtime 前置条件；安装状态和 IPC 生命周期由 DesktopApp 持有。 */
export function NodeRuntimeBlocker({ kind, status, progress, installing, onInstall }: NodeRuntimeBlockerProps) {
  const label = kind === "node" ? "Node.js" : "Git Bash";
  const invalidShellPath = kind === "shell" && status.state === "invalid";
  return (
    <AlertDialogPrimitive.Root open>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="node-runtime-overlay" />
        <AlertDialogPrimitive.Content className="node-runtime-blocker">
          <div>
            <AlertDialogPrimitive.Title className="node-runtime-title">
              需要 {label} 才能运行 Desktop sidecar
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description asChild>
              <div aria-live="polite">
                <p>{progress?.error ?? progress?.message ?? status.message}</p>
                <small>运行时仅安装到 Meta Agent 用户目录，不修改系统 PATH。</small>
              </div>
            </AlertDialogPrimitive.Description>
          </div>
          <div className="node-runtime-actions">
            <button type="button" onClick={() => void onInstall()} disabled={installing || invalidShellPath}>
              {invalidShellPath
                ? "请修正 settings.json 中的 shellPath"
                : installing
                  ? `安装中 ${progress?.percent ?? 0}%`
                  : `一键安装 ${label}`}
            </button>
            {progress && progress.phase !== "error" ? (
              <progress max={100} value={progress.percent} aria-label={`${label} 安装进度`} />
            ) : null}
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
