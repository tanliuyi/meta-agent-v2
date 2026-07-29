import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import type { NodeRuntimeProgress, NodeRuntimeStatus, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";

export interface RuntimeRequirement {
  kind: "node" | "shell";
  status: NodeRuntimeStatus | ShellRuntimeStatus;
  progress: NodeRuntimeProgress | null;
  installing: boolean;
  choosing: boolean;
  onInstall(): Promise<boolean>;
  onChoose?(): Promise<void>;
}

interface NodeRuntimeBlockerProps {
  requirements: RuntimeRequirement[];
  installingAll: boolean;
  onInstallAll(): Promise<void>;
}

/** 呈现 sidecar 的 runtime 前置条件；安装状态和 IPC 生命周期由 DesktopApp 持有。 */
export function NodeRuntimeBlocker({ requirements, installingAll, onInstallAll }: NodeRuntimeBlockerProps) {
  const busy = installingAll || requirements.some((requirement) => requirement.installing || requirement.choosing);

  return (
    <AlertDialogPrimitive.Root open>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="node-runtime-overlay" />
        <AlertDialogPrimitive.Content className="node-runtime-blocker">
          <AlertDialogPrimitive.Title className="node-runtime-title">缺少依赖项</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="sr-only">
            选择已有依赖项或自动安装
          </AlertDialogPrimitive.Description>

          <div className="node-runtime-list">
            {requirements.map((requirement) => {
              const label = requirement.kind === "node" ? "Node.js" : "Git Bash";
              const invalid = requirement.status.state === "invalid";
              const failed = requirement.progress?.phase === "error" || invalid;
              const message =
                requirement.progress?.phase === "error"
                  ? (requirement.progress.error ?? requirement.progress.message)
                  : requirement.status.message;
              return (
                <div className="node-runtime-item" key={requirement.kind}>
                  <div className="node-runtime-item-copy">
                    <strong>{label}</strong>
                    <span className={failed ? "node-runtime-error" : "node-runtime-message"} aria-live="polite">
                      {message}
                    </span>
                    {requirement.progress && requirement.progress.phase !== "error" ? (
                      <div className="node-runtime-progress">
                        <progress max={100} value={requirement.progress.percent} aria-label={`${label} 安装进度`} />
                        <span>{requirement.progress.percent}%</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="node-runtime-item-actions">
                    {requirement.onChoose ? (
                      <button
                        className="node-runtime-button secondary"
                        type="button"
                        onClick={() => void requirement.onChoose?.()}
                        disabled={busy}
                      >
                        <FolderOpen aria-hidden="true" />
                        {requirement.choosing ? "检查中" : "选择"}
                      </button>
                    ) : null}
                    <button
                      className="node-runtime-button primary"
                      type="button"
                      onClick={() => void requirement.onInstall()}
                      disabled={busy}
                    >
                      <Download aria-hidden="true" />
                      {requirement.installing ? "安装中" : "安装"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {requirements.length > 1 || installingAll ? (
            <div className="node-runtime-install-all">
              <button
                className="node-runtime-button primary"
                type="button"
                onClick={() => void onInstallAll()}
                disabled={busy}
              >
                <Download aria-hidden="true" />
                {installingAll ? "安装中" : "全部安装"}
              </button>
            </div>
          ) : null}
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
