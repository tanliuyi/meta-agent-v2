import { Button } from "@renderer/shared/ui/button";
import { updaterActions, useUpdaterState } from "@renderer/state/updater";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";

const VISIBLE_STATES = new Set(["available", "downloading", "ready"]);

/** Compact global update affordance shown above the chat sidebar footer. */
export function UpdateBanner() {
  const state = useUpdaterState();
  if (!VISIBLE_STATES.has(state.status)) return null;

  const percent = Math.max(0, Math.min(100, state.percent ?? 0));
  return (
    <aside className="update-banner" aria-live="polite">
      {/* 下载进度作为整个 cell 的底层横向填充,不参与 grid 布局,cell 高度保持 32px。 */}
      {state.status === "downloading" ? (
        <progress className="update-banner-progress" value={percent} max={100} aria-label="更新下载进度" />
      ) : null}
      <div className="update-banner-copy">
        <strong>
          {state.status === "available"
            ? `新版本 ${state.availableVersion ?? ""}`
            : state.status === "downloading"
              ? `下载中 ${percent.toFixed(0)}%`
              : `${state.availableVersion ?? "更新"} 已就绪`}
        </strong>
      </div>
      {state.status === "available" ? (
        <Button size="icon" aria-label="下载更新" title="下载更新" onClick={() => void updaterActions.download()}>
          <Download />
        </Button>
      ) : state.status === "ready" ? (
        <Button size="icon" aria-label="重启并安装" title="重启并安装" onClick={() => void updaterActions.install()}>
          <RotateCcw />
        </Button>
      ) : null}
    </aside>
  );
}
