import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectItem } from "../src/renderer/src/components/layout/project-item.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { DesktopActions } from "../src/renderer/src/state/desktop-actions.ts";
import { DesktopActionsContext } from "../src/renderer/src/state/desktop-context.tsx";
import { INITIAL_STATE } from "../src/renderer/src/state/desktop-model.ts";
import { DesktopStoreProvider } from "../src/renderer/src/state/desktop-store-context.tsx";
import type { Project, Thread } from "../src/shared/contracts.ts";

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

  it("收起时用 loading 标记项目中正在运行的任务", () => {
    const markup = renderProjectItem(false, [runningThread]);

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Project 中有任务正在运行"');
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).toContain("group-hover:w-12");
    expect(markup).toContain('aria-label="在 Project 中新建任务"');
    expect(markup.indexOf('aria-label="Project 中有任务正在运行"')).toBeLessThan(
      markup.indexOf('aria-label="在 Project 中新建任务"'),
    );
    expect(markup).toContain("group-hover:opacity-100");
  });

  it("收起但没有运行中任务时不展示 loading", () => {
    const markup = renderProjectItem(false, [{ ...runningThread, running: false }]);

    expect(markup).not.toContain('aria-label="Project 中有任务正在运行"');
  });

  it("收起时忽略已归档的运行中任务", () => {
    const markup = renderProjectItem(false, [{ ...runningThread, archived: true }]);

    expect(markup).not.toContain('aria-label="Project 中有任务正在运行"');
  });
});

const runningThread: Thread = {
  id: "thread",
  projectId: project.id,
  title: "Running thread",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 1,
  preview: "",
  archived: false,
  running: true,
};

function renderProjectItem(active: boolean, threads?: Thread[]): string {
  return renderToStaticMarkup(
    <DesktopStoreProvider
      initialState={threads ? { ...INITIAL_STATE, threadCatalogs: { [project.id]: threads } } : undefined}
    >
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
    renameProject: vi.fn(),
    openProjectExternally: vi.fn(),
    removeProject: vi.fn(),
    prewarmThread: vi.fn(),
    renameThread: vi.fn(),
    setThreadArchived: vi.fn(),
    removeThread: vi.fn(),
    clearError: vi.fn(),
  };
}
