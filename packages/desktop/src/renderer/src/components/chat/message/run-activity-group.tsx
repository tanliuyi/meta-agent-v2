import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ReasoningContent } from "../../assistant-ui/reasoning/reasoning-content.tsx";
import { ReasoningRoot } from "../../assistant-ui/reasoning/reasoning-root.tsx";
import { ReasoningTrigger } from "../../assistant-ui/reasoning/reasoning-trigger.tsx";

export function RunActivityGroup({
  running,
  startedAt,
  completedAt,
  hasContent,
  children,
}: {
  running: boolean;
  startedAt: number;
  completedAt?: number;
  hasContent: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(() =>
    running ? elapsedDuration(startedAt, Date.now()) : completedDuration(startedAt, completedAt),
  );
  const previousRunning = useRef(running);

  useEffect(() => {
    if (!running) {
      if (previousRunning.current) setOpen(false);
      setElapsedSeconds(
        completedAt === undefined && previousRunning.current
          ? elapsedDuration(startedAt, Date.now())
          : completedDuration(startedAt, completedAt),
      );
    }
    previousRunning.current = running;
  }, [completedAt, running, startedAt]);

  useEffect(() => {
    if (!running) return;
    setElapsedSeconds(elapsedDuration(startedAt, Date.now()));
    const interval = setInterval(() => setElapsedSeconds(elapsedDuration(startedAt, Date.now())), 1_000);
    return () => clearInterval(interval);
  }, [running, startedAt]);

  const stateLabel = running ? "正在处理" : "已处理";
  const elapsedLabel = elapsedSeconds === null ? "" : formatElapsedDuration(elapsedSeconds);
  const label = elapsedLabel ? `${stateLabel} ${elapsedLabel}` : stateLabel;

  return (
    <ReasoningRoot
      variant="ghost"
      className="aui-run-activity-root"
      open={running || open}
      onOpenChange={(nextOpen) => {
        if (!running && hasContent) setOpen(nextOpen);
      }}
    >
      <ReasoningTrigger
        className="aui-run-activity-trigger"
        label={label}
        active={running}
        hideChevron={running || !hasContent}
        disabled={running || !hasContent}
      />
      {hasContent ? (
        <ReasoningContent className="aui-run-activity-content text-foreground" fade={false} aria-busy={running}>
          <div className="aui-run-activity-body flex flex-col gap-3 py-2">{children}</div>
        </ReasoningContent>
      ) : null}
    </ReasoningRoot>
  );
}

function completedDuration(startedAt: number, completedAt: number | undefined): number | null {
  return completedAt === undefined ? null : elapsedDuration(startedAt, completedAt);
}

function elapsedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
}

function formatElapsedDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "";

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [...(hours > 0 ? [`${hours}h`] : []), ...(minutes > 0 ? [`${minutes}m`] : []), `${seconds}s`];
  return parts.join("");
}
