import { Button } from "@renderer/shared/ui/button";
import { updaterActions, useUpdaterState } from "@renderer/state/updater";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import appIcon from "../../../../../../build/icon.png";

/** Displays product version and the complete manual update workflow. */
export function AboutSettingsPage() {
  const state = useUpdaterState();
  const busy = state.status === "checking" || state.status === "downloading";
  const percent = Math.max(0, Math.min(100, state.percent ?? 0));

  return (
    <div className="settings-content about-settings">
      <header className="about-product">
        <img className="about-product-mark" src={appIcon} alt="" />
        <div>
          <h2>Meta Agent</h2>
          <p>你的桌面智能助手</p>
        </div>
      </header>

      <section className="settings-section" aria-labelledby="software-update-heading">
        <div className="settings-section-heading about-update-heading">
          <div>
            <h3 id="software-update-heading">软件更新</h3>
            <p>{state.currentVersion ? `当前版本 ${state.currentVersion}` : "正在获取版本信息..."}</p>
          </div>
          {state.status === "available" ? (
            <Button size="sm" onClick={() => void updaterActions.download()}>
              <Download />
              下载更新
            </Button>
          ) : state.status === "ready" ? (
            <Button size="sm" onClick={() => void updaterActions.install()}>
              <RotateCcw />
              重启并安装
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || state.status === "unsupported"}
              onClick={() => void updaterActions.check()}
            >
              <RefreshCw className={state.status === "checking" ? "update-spin" : undefined} />
              检查更新
            </Button>
          )}
        </div>
        <div className="about-update-status" data-error={state.status === "error" || undefined} aria-live="polite">
          <div>
            <span>{statusText(state.status, state.availableVersion, percent)}</span>
          </div>
          {state.status === "downloading" ? <progress value={percent} max={100} aria-label="更新下载进度" /> : null}
        </div>
        {state.releaseNotes ? <pre className="about-release-notes">{state.releaseNotes}</pre> : null}
      </section>

      <footer className="about-footer">
        <span>© Meta Agent</span>
      </footer>
    </div>
  );
}

function statusText(
  status: ReturnType<typeof useUpdaterState>["status"],
  version: string | undefined,
  percent: number,
): string {
  switch (status) {
    case "checking":
      return "正在检查更新...";
    case "available":
      return `发现新版本 ${version ?? ""}`;
    case "downloading":
      return `正在下载 ${percent.toFixed(0)}%`;
    case "ready":
      return `版本 ${version ?? ""} 已准备就绪`;
    case "up-to-date":
      return "当前已是最新版本";
    case "error":
      return "更新失败，请稍后重试";
    case "unsupported":
      return "当前版本暂不支持在线更新";
    default:
      return "尚未检查更新";
  }
}
