import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectItem } from "../src/renderer/src/components/layout/project-item.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { DesktopActions } from "../src/renderer/src/state/desktop-actions.ts";
import { DesktopActionsContext } from "../src/renderer/src/state/desktop-context.tsx";
import { DesktopStoreProvider } from "../src/renderer/src/state/desktop-store-context.tsx";
import type { Project } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "Project",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

describe("ProjectItem", () => {
  it("当前会话路由所属 Project 首帧保持展开", () => {
    const markup = renderProjectItem(true);

    expect(markup).toContain('data-project-id="project"');
    expect(markup).toContain('data-active="true"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('id="project-threads-project"');
    expect(markup).not.toContain('id="project-threads-project" hidden=""');
  });

  it("首帧优先恢复持久化的收起状态", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({ version: 1, projects: [[project.id, false]] }),
      },
    });

    try {
      const markup = renderProjectItem(true);
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).toContain('id="project-threads-project" hidden=""');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function renderProjectItem(active: boolean): string {
  return renderToStaticMarkup(
    <DesktopStoreProvider>
      <DesktopActionsContext.Provider value={desktopActions()}>
        <TooltipProvider>
          <ProjectItem project={project} active={active} newTaskDisabled={false} onNewTask={vi.fn()} />
        </TooltipProvider>
      </DesktopActionsContext.Provider>
    </DesktopStoreProvider>,
  );
}

function desktopActions(): DesktopActions {
  return {
    chooseProject: vi.fn(),
    loadProjectThreads: vi.fn(async () => undefined),
    refreshProjectThreads: vi.fn(async () => undefined),
    activateProject: vi.fn(),
    removeProject: vi.fn(),
    prewarmThread: vi.fn(),
    renameThread: vi.fn(),
    setThreadArchived: vi.fn(),
    removeThread: vi.fn(),
    clearError: vi.fn(),
  };
}
