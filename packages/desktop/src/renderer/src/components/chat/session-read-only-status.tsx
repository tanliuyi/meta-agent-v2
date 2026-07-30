import Cpu from "lucide-react/dist/esm/icons/cpu.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import type { PiThreadPhase, SessionControlState } from "../../../../shared/contracts.ts";
import { getThinkingLevelLabel } from "../../shared/lib/thinking-level-label.ts";

const SUBAGENT_PHASE_LABELS: Record<Exclude<PiThreadPhase, "idle">, string> = {
  running: "子智能体运行中",
  retrying: "子智能体正在重试",
  compacting: "子智能体正在压缩上下文",
  "tree-navigation": "子智能体正在切换会话节点",
};

interface ReadOnlySessionStatusProps {
  phase: PiThreadPhase;
  model: SessionControlState["model"];
  thinkingLevel: SessionControlState["thinkingLevel"];
}

export function ReadOnlySessionStatus({ phase, model, thinkingLevel }: ReadOnlySessionStatusProps) {
  const syncing = phase === "idle";

  return (
    <div
      className="border-border/60 flex min-h-10 items-center justify-center gap-2 rounded-xl border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-sm"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground/80">
          {syncing ? "正在同步子智能体会话" : SUBAGENT_PHASE_LABELS[phase]}
        </span>
        {!syncing && model ? (
          <span className="flex min-w-0 max-w-full items-center gap-1.5" title={`${model.provider}/${model.id}`}>
            <Cpu className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">模型：{model.name}</span>
            <span className="shrink-0 text-muted-foreground/70">({model.provider})</span>
          </span>
        ) : null}
        {!syncing ? <span>思考：{getThinkingLevelLabel(thinkingLevel)}</span> : null}
        <span>{syncing ? "请稍候" : "此会话暂时只读"}</span>
      </div>
    </div>
  );
}
