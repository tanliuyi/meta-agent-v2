// @vitest-environment jsdom

import React, { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiGoalSnapshot } from "../src/shared/pi-goal-contracts.ts";

const runGoalAction = vi.hoisted(() => vi.fn());

vi.mock("../src/renderer/src/shared/ui/button.tsx", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock("../src/renderer/src/shared/ui/input.tsx", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("../src/renderer/src/shared/ui/tooltip.tsx", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../src/renderer/src/shared/ui/tooltip-trigger.tsx", () => ({
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../src/renderer/src/shared/ui/tooltip-content.tsx", () => ({
  TooltipContent: () => null,
}));

vi.mock("../src/renderer/src/shared/ui/confirm-dialog.tsx", () => ({
  ConfirmDialog: ({ open, title, onConfirm }: { open: boolean; title: string; onConfirm(): void | Promise<void> }) =>
    open ? (
      <div role="dialog">
        <span>{title}</span>
        <button type="button" aria-label="确认关闭目标" onClick={() => void onConfirm()}>
          关闭
        </button>
      </div>
    ) : null,
}));

import { GoalToolbar } from "../src/renderer/src/components/chat/composer/goal-control.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  runGoalAction.mockResolvedValue(activeSnapshot());
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { sessions: { runGoalAction } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <GoalToolbar
        projectId="project-1"
        threadId="thread-1"
        snapshot={activeSnapshot()}
        phase="idle"
        readOnly={false}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  runGoalAction.mockReset();
});

describe("GoalToolbar interactions", () => {
  it("edits the current objective inline", async () => {
    await clickButton("编辑目标");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="目标内容"]');
    expect(input?.value).toBe("完成 Desktop Goal 集成");

    await act(async () => {
      setInputValue(input!, "完成新的目标");
    });
    await clickButton("保存目标");

    expect(runGoalAction).toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-1",
      action: { type: "edit", expectedGoalId: "goal-1", objective: "完成新的目标" },
    });
  });

  it("confirms before clearing the current Goal", async () => {
    await clickButton("关闭目标");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("关闭目标");

    await clickButton("确认关闭目标");

    expect(runGoalAction).toHaveBeenCalledWith({
      projectId: "project-1",
      threadId: "thread-1",
      action: { type: "clear", expectedGoalId: "goal-1" },
    });
  });
});

async function clickButton(label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
