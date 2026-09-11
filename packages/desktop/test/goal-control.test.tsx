import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoalToolbar } from "../src/renderer/src/components/chat/composer/goal-control.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { PiGoalSnapshot, PiGoalStatus } from "../src/shared/pi-goal-contracts.ts";

describe("GoalToolbar", () => {
  it("renders the active Goal above the composer without a popover trigger", () => {
    const markup = renderToolbar(activeSnapshot());

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain("执行中");
    expect(markup).toContain("完成 Desktop Goal 集成");
    expect(markup).toContain('aria-label="编辑目标"');
    expect(markup).toContain('aria-label="暂停 Goal"');
    expect(markup).toContain('aria-label="关闭目标"');
    expect(markup).toContain("3 轮");
    expect(markup).not.toContain("创建 Goal");
    expect(markup).not.toContain('aria-haspopup="dialog"');
  });

  it("renders a resume action for a paused Goal", () => {
    const markup = renderToolbar(snapshotWithStatus("paused"));

    expect(markup).toContain("已暂停");
    expect(markup).toContain('aria-label="继续 Goal"');
  });

  it.each(["blocked", "usage_limited", "budget_limited"] as const)("stays hidden for %s Goals", (status) => {
    expect(renderToolbar(snapshotWithStatus(status))).toBe("");
  });

  it("stays hidden when no active or paused Goal exists", () => {
    expect(renderToolbar({ settings: { rpcEnabled: false, automaticTurnLimit: 25, noProgressTurnLimit: 3 } })).toBe("");
    expect(renderToolbar()).toBe("");
  });
});

function renderToolbar(snapshot?: PiGoalSnapshot): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <GoalToolbar projectId="project-1" threadId="thread-1" snapshot={snapshot} phase="idle" readOnly={false} />
    </TooltipProvider>,
  );
}

function snapshotWithStatus(status: PiGoalStatus): PiGoalSnapshot {
  const snapshot = activeSnapshot();
  snapshot.goal!.status = status;
  return snapshot;
}

function activeSnapshot(): PiGoalSnapshot {
  return {
    settings: { rpcEnabled: false, automaticTurnLimit: 25, noProgressTurnLimit: 3 },
    goal: {
      id: "goal-1",
      objective: "完成 Desktop Goal 集成",
      status: "active",
      startedAt: 1,
      updatedAt: 2,
      iteration: 3,
      tokenBudget: 20_000,
      tokensUsed: 12_000,
      timeUsedSeconds: 90,
      automaticModelTurns: 2,
      automaticTurnLimit: 25,
      noProgressTurns: 0,
      noProgressTurnLimit: 3,
    },
  };
}
