import CircleCheck from "lucide-react/dist/esm/icons/circle-check.mjs";
import CircleX from "lucide-react/dist/esm/icons/circle-x.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import type { ShellRuntimeProgress, ShellRuntimeStatus } from "../../../../shared/desktop-api.ts";
import { Button } from "../../shared/ui/button.tsx";

interface DependencyRowProps {
  label: string;
  status: ShellRuntimeStatus | null;
  progress: ShellRuntimeProgress | null;
  installing: boolean;
  choosing?: boolean;
  busy: boolean;
  onInstall(): Promise<boolean>;
  onChoose?(): Promise<void>;
}

export function DependencyRow({
  label,
  status,
  progress,
  installing,
  choosing = false,
  busy,
  onInstall,
  onChoose,
}: DependencyRowProps) {
  const ready = status?.state === "ready";
  const statusLabel = status ? (ready ? "可用" : status.state === "invalid" ? "不可用" : "缺失") : "检查中";
  const failed = progress?.phase === "error" || status?.state === "invalid";
  const detail = progress?.phase === "error" ? (progress.error ?? progress.message) : status?.message;
  return (
    <div className="settings-row dependency-row">
      <div className="settings-row-text">
        <span className="dependency-name" data-ready={ready || undefined}>
          {ready ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}
          {label}
        </span>
        <p className="settings-row-description">
          {statusLabel}
          {status?.version ? ` · ${status.version}` : ""}
        </p>
        {detail ? (
          <p
            className={failed ? "settings-row-description dependency-error" : "settings-row-description"}
            role={failed ? "alert" : undefined}
          >
            {detail}
          </p>
        ) : null}
        {progress && progress.phase !== "error" ? (
          <div className="dependency-progress">
            <progress max={100} value={progress.percent} aria-label={`${label} 安装进度`} />
            <span>{progress.percent}%</span>
          </div>
        ) : null}
      </div>
      <div className="dependency-actions">
        {onChoose ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void onChoose()}>
            <FolderOpen />
            {choosing ? "检查中" : "选择"}
          </Button>
        ) : null}
        <Button variant={ready ? "outline" : "default"} size="sm" disabled={busy} onClick={() => void onInstall()}>
          <Download />
          {installing ? "安装中" : ready ? "重新安装" : "安装"}
        </Button>
      </div>
    </div>
  );
}
