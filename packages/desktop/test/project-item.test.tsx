import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectItem } from "../src/renderer/src/components/layout/project-item.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { DesktopActions } from "../src/renderer/src/state/desktop-actions.ts";
import { DesktopActionsContext } from "../src/renderer/src/state/desktop-context.tsx";
import { INITIAL_STATE } from "../src/renderer/src/state/desktop-model.ts";
import { DesktopStoreProvider } from "../src/renderer/src/state/desktop-store-context.tsx";
import { preferencesStorage } from "../src/renderer/src/state/preferences-store.ts";
import { PROJECT_EXPANSION_STORAGE_KEY } from "../src/renderer/src/state/project-expansion-preference.ts";
import { ThreadPinningProvider } from "../src/renderer/src/state/thread-pinning-context.tsx";
import { PINNED_THREADS_STORAGE_KEY } from "../src/renderer/src/state/thread-pinning-preference.ts";
import type { Project, Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "Project",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

beforeEach(() => {
  preferencesStorage.reset();
  vi.stubGlobal("window", {
    desktop: {
      platform: "win32",
      preferences: {
        getInitial: () => ({ path: "preferences.json", exists: true, values: {} }),
        save: () => Promise.resolve({ status: "saved" }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    preferencesStorage.reset();
    vi.stubGlobal("window", {
      desktop: {
        platform: "win32",
        preferences: {
          getInitial: () => ({
            path: "preferences.json",
            exists: true,
            values: {
              [PROJECT_EXPANSION_STORAGE_KEY]: JSON.stringify({
                version: 1,
                projects: [[project.id, false]],
              }),
            },
          }),
          save: () => Promise.resolve({ status: "saved" }),
        },
      },
    });

    const markup = renderProjectItem(true);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="project-threads-project" hidden=""');
  });

  it("置顶会话不再显示在原项目列表中", () => {
    const pinned = { ...runningThread, id: "pinned", title: "Pinned thread" };
    preferencesStorage.reset();
    vi.stubGlobal("window", {
      desktop: {
        platform: "win32",
        preferences: {
          getInitial: () => ({
            path: "preferences.json",
            exists: true,
            values: {
              [PINNED_THREADS_STORAGE_KEY]: JSON.stringify({
                version: 1,
                threads: [[project.id, pinned.id]],
              }),
            },
          }),
          save: () => Promise.resolve({ status: "saved" }),
        },
      },
    });

    const markup = renderProjectItem(true, [pinned]);

    expect(markup).not.toContain("Pinned thread");
    expect(markup).toContain("没有会话");
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

  it("收起时用完成点标记项目中已结束且未查看的任务", () => {
    const markup = renderProjectItem(false, [{ ...runningThread, running: false, completed: true }]);

    expect(markup).toContain('aria-label="Project 中有任务已完成"');
    expect(markup).toContain('class="completed-dot"');
    expect(markup).not.toContain('aria-label="Project 中有任务正在运行"');
  });

  it("收起时优先显示运行指示而非完成点", () => {
    const markup = renderProjectItem(false, [{ ...runningThread, running: false, completed: true }, runningThread]);

    expect(markup).toContain('aria-label="Project 中有任务正在运行"');
    expect(markup).not.toContain('aria-label="Project 中有任务已完成"');
  });

  it("收起时忽略已归档或仍在运行的完成点任务", () => {
    const archivedMarkup = renderProjectItem(false, [
      { ...runningThread, running: false, completed: true, archived: true },
    ]);
    expect(archivedMarkup).not.toContain('aria-label="Project 中有任务已完成"');

    const runningMarkup = renderProjectItem(false, [{ ...runningThread, completed: true }]);
    expect(runningMarkup).not.toContain('aria-label="Project 中有任务已完成"');
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
        <ThreadPinningProvider>
          <TooltipProvider>
            <ProjectItem project={project} active={active} newTaskDisabled={false} onNewTask={vi.fn()} />
          </TooltipProvider>
        </ThreadPinningProvider>
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
    stopThread: vi.fn(),
    setThreadArchived: vi.fn(),
    removeThread: vi.fn(),
    clearError: vi.fn(),
  };
}
