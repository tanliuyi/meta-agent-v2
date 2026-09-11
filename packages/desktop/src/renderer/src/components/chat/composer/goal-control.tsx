import Check from "lucide-react/dist/esm/icons/check.mjs";
import CirclePause from "lucide-react/dist/esm/icons/circle-pause.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Play from "lucide-react/dist/esm/icons/play.mjs";
import Target from "lucide-react/dist/esm/icons/target.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type FormEvent, type ReactNode, useState } from "react";
import type { PiThreadPhase } from "../../../../../shared/contracts.ts";
import type { PiGoalSnapshot, SessionGoalActionInput } from "../../../../../shared/pi-goal-contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { Button } from "../../../shared/ui/button.tsx";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.tsx";
import { Input } from "../../../shared/ui/input.tsx";
import { Tooltip } from "../../../shared/ui/tooltip.tsx";
import { TooltipContent } from "../../../shared/ui/tooltip-content.tsx";
import { TooltipTrigger } from "../../../shared/ui/tooltip-trigger.tsx";

interface GoalToolbarProps {
  projectId: string;
  threadId: string;
  snapshot?: PiGoalSnapshot;
  phase: PiThreadPhase;
  readOnly: boolean;
}

export function GoalToolbar({ projectId, threadId, snapshot, phase, readOnly }: GoalToolbarProps) {
  const goal = snapshot?.goal;
  const [pending, setPending] = useState<SessionGoalActionInput["action"]["type"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftObjective, setDraftObjective] = useState("");
  const [confirmingClose, setConfirmingClose] = useState(false);
  if (!goal || (goal.status !== "active" && goal.status !== "paused")) return null;

  const waiting = goal.status === "active" && goal.waiting !== undefined;
  const canPause = goal.status === "active" && !waiting;
  const running = phase !== "idle";
  const runAction = async (action: SessionGoalActionInput["action"]): Promise<boolean> => {
    setPending(action.type);
    setError(null);
    try {
      await window.desktop.sessions.runGoalAction({ projectId, threadId, action });
      return true;
    } catch (value) {
      setError(errorMessage(value));
      return false;
    } finally {
      setPending(null);
    }
  };

  const startEditing = () => {
    setDraftObjective(goal.objective);
    setError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setDraftObjective("");
    setEditing(false);
  };

  const saveObjective = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const objective = draftObjective.trim();
    if (!objective || objective === goal.objective) return;
    if (await runAction({ type: "edit", expectedGoalId: goal.id, objective })) cancelEditing();
  };

  const clearGoal = async (): Promise<void> => {
    if (!(await runAction({ type: "clear", expectedGoalId: goal.id }))) {
      throw new Error("Goal was not cleared");
    }
  };

  return (
    <>
      <div
        className="goal-toolbar mb-2 flex min-h-10 w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 shadow-sm"
        role="toolbar"
        aria-label="Goal 状态"
      >
        <Target className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {goal.status === "paused" ? "已暂停" : waiting ? "等待中" : "执行中"}
        </span>
        {editing ? (
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(event) => void saveObjective(event)}>
            <Input
              autoFocus
              aria-label="目标内容"
              className="h-7 min-w-0 rounded-md px-2 text-xs"
              value={draftObjective}
              disabled={pending !== null}
              onChange={(event) => setDraftObjective(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelEditing();
              }}
            />
            {error ? (
              <span className="max-w-32 truncate text-xs text-destructive" role="alert" title={error}>
                {error}
              </span>
            ) : null}
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="保存目标"
              disabled={pending !== null || !draftObjective.trim() || draftObjective.trim() === goal.objective}
            >
              {pending === "edit" ? <LoaderCircle className="animate-spin" /> : <Check />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="取消编辑目标"
              disabled={pending !== null}
              onClick={cancelEditing}
            >
              <X />
            </Button>
          </form>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={goal.objective}>
              {goal.objective}
            </span>
            <span className="hidden shrink-0 items-center gap-2 text-[10px] tabular-nums text-muted-foreground sm:flex">
              <span>{goal.iteration} 轮</span>
              <span>{formatTokenUsage(goal.tokensUsed, goal.tokenBudget)}</span>
              <span>{formatDuration(goal.timeUsedSeconds)}</span>
            </span>
            {error ? (
              <span className="max-w-44 truncate text-xs text-destructive" role="alert" title={error}>
                {error}
              </span>
            ) : null}
            <GoalActionButton label="编辑目标" disabled={readOnly || pending !== null} onClick={startEditing}>
              <Pencil />
            </GoalActionButton>
            <Tooltip delayDuration={800}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={canPause ? "暂停 Goal" : "继续 Goal"}
                  disabled={readOnly || pending !== null || (!canPause && running)}
                  onClick={() =>
                    void runAction({
                      type: canPause ? "pause" : "resume",
                      expectedGoalId: goal.id,
                    })
                  }
                >
                  {pending === "pause" || pending === "resume" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : canPause ? (
                    <CirclePause />
                  ) : (
                    <Play />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{canPause ? "暂停 Goal" : "继续 Goal"}</TooltipContent>
            </Tooltip>
            <GoalActionButton
              label="关闭目标"
              disabled={readOnly || pending !== null}
              onClick={() => setConfirmingClose(true)}
            >
              <X />
            </GoalActionButton>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmingClose}
        title="关闭目标"
        description="关闭后将停止当前目标，已经生成的会话内容会保留。"
        confirmLabel="关闭"
        onOpenChange={setConfirmingClose}
        onConfirm={clearGoal}
      />
    </>
  );
}

interface GoalActionButtonProps {
  label: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}

function GoalActionButton({ label, disabled, onClick, children }: GoalActionButtonProps) {
  return (
    <Tooltip delayDuration={800}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function formatTokenUsage(used: number, budget?: number): string {
  const formattedUsed = formatCount(used);
  return budget === undefined ? `${formattedUsed} Token` : `${formattedUsed}/${formatCount(budget)} Token`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
  return `${(seconds / 3600).toFixed(1)}时`;
}
