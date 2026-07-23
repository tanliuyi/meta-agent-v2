import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import AlertCircle from "lucide-react/dist/esm/icons/circle-alert.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import type { ReactNode } from "react";
import type { PiThreadPhase, SessionControlState } from "../../../../shared/contracts.ts";

type Activity = {
  kind: "compacting" | "retrying" | "error";
  label: string;
  detail?: string;
  icon: ReactNode;
};

interface ThreadActivityIndicatorProps {
  phase: PiThreadPhase;
  retry: SessionControlState["retry"];
  lastError: string | undefined;
}

/** Pi-specific activity rendered at the end of the message timeline. */
export function ThreadActivityIndicator(props: ThreadActivityIndicatorProps) {
  const activity = getActivity(props);
  if (!activity) return null;

  const className =
    activity.kind === "error"
      ? "group/thread-activity flex w-full flex-col text-sm text-destructive"
      : "group/thread-activity flex w-full flex-col text-sm text-muted-foreground my-2";

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

function getActivity(control: ThreadActivityIndicatorProps): Activity | null {
  if (control.phase === "retrying") {
    return {
      kind: "retrying",
      label: control.retry ? `正在重试 ${control.retry.attempt}/${control.retry.maxAttempts}` : "正在重试",
      ...(control.retry?.message ? { detail: control.retry.message } : undefined),
      icon: <RotateCw className="size-4 shrink-0 animate-spin" />,
    };
  }
  if (control.phase === "compacting") {
    return {
      kind: "compacting",
      label: "会话压缩中",
      icon: <LoaderCircle className="size-4 shrink-0 animate-spin" />,
    };
  }
  if (control.phase === "idle" && control.lastError) {
    return {
      kind: "error",
      label: "运行出错",
      detail: control.lastError,
      icon: <AlertCircle className="size-4 shrink-0" />,
    };
  }
  return null;
}
