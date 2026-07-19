import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ReasoningContent } from "../../assistant-ui/reasoning/reasoning-content.tsx";
import { ReasoningRoot } from "../../assistant-ui/reasoning/reasoning-root.tsx";
import { ReasoningTrigger } from "../../assistant-ui/reasoning/reasoning-trigger.tsx";

export function RunActivityGroup({ running, children }: { running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const previousRunning = useRef(running);

  useEffect(() => {
    if (previousRunning.current && !running) setOpen(false);
    previousRunning.current = running;
  }, [running]);

  return (
    <ReasoningRoot
      variant="ghost"
      className="aui-run-activity-root"
      open={running || open}
      onOpenChange={(nextOpen) => {
        if (!running) setOpen(nextOpen);
      }}
    >
      <ReasoningTrigger
        className="aui-run-activity-trigger"
        label={running ? "正在处理" : "已处理"}
        active={running}
        disabled={running}
      />
      <ReasoningContent className="aui-run-activity-content text-foreground" fade={false} aria-busy={running}>
        <div className="aui-run-activity-body flex flex-col gap-3 py-2">{children}</div>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
