import { AlertCircle, ChevronDown, LoaderCircle, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionControlState } from "../../../../shared/contracts.ts";
import { usePiThreadPhase } from "../../runtime/use-pi-thread-snapshot.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

type Activity = {
  kind: "compacting" | "retrying" | "working" | "error";
  label: string;
  detail?: string;
  icon: ReactNode;
};

/** Pi-specific activity rendered at the end of the message timeline. */
export function ThreadActivityIndicator({ snapshot }: { snapshot: SessionControlState }) {
  const phase = usePiThreadPhase();
  const activity = getActivity(snapshot, phase);
  if (!activity) return null;

  const className =
    activity.kind === "error"
      ? "group/thread-activity flex w-full flex-col text-sm text-destructive"
      : "group/thread-activity flex w-full flex-col text-sm text-muted-foreground";

  if (!activity.detail) {
    return (
      <div className={className} aria-live="polite">
        <div className="flex min-h-8 items-center gap-2 py-1.5">
          {activity.icon}
          <span>{activity.label}</span>
        </div>
      </div>
    );
  }

  return (
    <Collapsible
      className={className}
      defaultOpen={activity.kind === "error"}
      role={activity.kind === "error" ? "alert" : undefined}
      aria-live={activity.kind === "error" ? "assertive" : "polite"}
    >
      <CollapsibleTrigger
        className="group/trigger flex min-h-8 w-full items-center gap-2 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label={`${activity.label}，切换详细信息`}
      >
        {activity.icon}
        <span className="min-w-0 flex-1">{activity.label}</span>
        <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform group-data-open/trigger:rotate-0" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-40 overflow-auto pb-2 pl-6 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">
          {activity.detail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function getActivity(snapshot: SessionControlState, phase: ReturnType<typeof usePiThreadPhase>): Activity | null {
  if (phase === "retrying") {
    return {
      kind: "retrying",
      label: snapshot.retry ? `正在重试 ${snapshot.retry.attempt}/${snapshot.retry.maxAttempts}` : "正在重试",
      ...(snapshot.retry?.message ? { detail: snapshot.retry.message } : undefined),
      icon: <RotateCw className="size-4 shrink-0 animate-spin" />,
    };
  }
  if (phase === "compacting") {
    return {
      kind: "compacting",
      label: "会话压缩中",
      icon: <LoaderCircle className="size-4 shrink-0 animate-spin" />,
    };
  }
  if (phase === "running" && snapshot.extensionUi.workingVisible) {
    return {
      kind: "working",
      label: snapshot.extensionUi.workingMessage ?? "Pi 正在处理",
      icon: <LoaderCircle className="size-4 shrink-0 animate-spin" />,
    };
  }
  if (phase === "idle" && snapshot.lastError) {
    return {
      kind: "error",
      label: "运行出错",
      detail: snapshot.lastError,
      icon: <AlertCircle className="size-4 shrink-0" />,
    };
  }
  return null;
}
