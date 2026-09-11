// @vitest-environment jsdom

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/shared/contracts.ts";

interface MockProjectItemProps {
  project: Project;
  reordering?: boolean;
  onMoveUp?(): void;
  onMoveDown?(): void;
  children?: ReactNode;
}

const testState = vi.hoisted(() => ({
  projects: ["first", "second", "third"].map((id, index) => ({
    id,
    name: id,
    cwd: `C:/${id}`,
    lastOpenedAt: index,
    available: true,
  })) as Project[],
  reorderProjects: vi.fn<(projectIds: string[]) => Promise<void>>(),
}));

const originalProjects = testState.projects;

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopActions: () => ({ reorderProjects: testState.reorderProjects }),
  useDesktopSelector: () => testState.projects,
}));

vi.mock("../src/renderer/src/components/layout/project-item.tsx", () => ({
  ProjectItem: ({ project, reordering, onMoveUp, onMoveDown }: MockProjectItemProps) => (
    <li data-project-id={project.id}>
      <button type="button" aria-label={`上移 ${project.id}`} disabled={reordering || !onMoveUp} onClick={onMoveUp}>
        上移
      </button>
      <button type="button" aria-label={`下移 ${project.id}`} disabled={reordering || !onMoveDown} onClick={onMoveDown}>
        下移
      </button>
    </li>
  ),
}));

import { ProjectList } from "../src/renderer/src/components/layout/project-list.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  testState.projects = originalProjects;
  testState.reorderProjects.mockReset();
  testState.reorderProjects.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ProjectList activeProjectId={null} newTaskDisabled={false} onNewTask={() => undefined} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function moveButton(direction: "上移" | "下移", projectId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${direction} ${projectId}"]`);
  if (!button) throw new Error(`Expected ${direction} button for ${projectId}`);
  return button;
}

describe("ProjectList interactions", () => {
  it("项目列表从空态更新后保持 hooks 顺序稳定", async () => {
    testState.projects = [];
    await act(async () => {
      root.render(<ProjectList activeProjectId={null} newTaskDisabled={false} onNewTask={() => undefined} />);
    });
    expect(container.textContent).toContain("没有项目");

    testState.projects = originalProjects;
    await act(async () => {
      root.render(<ProjectList activeProjectId={null} newTaskDisabled={false} onNewTask={() => undefined} />);
    });
    expect(moveButton("下移", "first").disabled).toBe(false);
  });

  it("在列表边界禁用无效的移动操作", () => {
    expect(moveButton("上移", "first").disabled).toBe(true);
    expect(moveButton("下移", "first").disabled).toBe(false);
    expect(moveButton("上移", "third").disabled).toBe(false);
    expect(moveButton("下移", "third").disabled).toBe(true);
  });

  it("排序持久化完成前拒绝重复移动", async () => {
    let finishReorder: (() => void) | undefined;
    testState.reorderProjects.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishReorder = resolve;
        }),
    );
    const moveUp = moveButton("上移", "second");
    const moveDown = moveButton("下移", "second");

    await act(async () => {
      moveUp.click();
      moveDown.click();
    });

    expect(testState.reorderProjects).toHaveBeenCalledTimes(1);
    expect(testState.reorderProjects).toHaveBeenCalledWith(["second", "first", "third"]);
    expect(moveButton("上移", "second").disabled).toBe(true);
    expect(moveButton("下移", "second").disabled).toBe(true);

    await act(async () => finishReorder?.());

    expect(moveButton("上移", "second").disabled).toBe(false);
    expect(moveButton("下移", "second").disabled).toBe(false);
  });
});
