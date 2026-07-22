import { describe, expect, it } from "vitest";
import {
  selectHasAvailableProject,
  selectProjects,
  selectProjectThreads,
} from "../src/renderer/src/state/desktop-selectors.ts";
import { createDesktopStore, dispatchDesktop } from "../src/renderer/src/state/desktop-store.ts";
import type { Project, Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "workspace",
  cwd: "/workspace",
  lastOpenedAt: 1,
  available: true,
};

const thread: Thread = {
  id: "thread",
  projectId: project.id,
  title: "会话",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "",
  archived: false,
  running: false,
};

describe("desktop catalog selectors", () => {
  it("只暴露窗口级 Project 和 thread summary", () => {
    const store = createDesktopStore();
    dispatchDesktop(store, {
      type: "projects-loaded",
      projects: [project],
      activeProjectId: project.id,
    });
    dispatchDesktop(store, { type: "project-threads-loaded", projectId: project.id, threads: [thread] });

    expect(selectProjects(store.getState())).toEqual([project]);
    expect(selectProjectThreads(store.getState(), project.id)).toEqual([thread]);
    expect(selectHasAvailableProject(store.getState())).toBe(true);
    expect(store.getState()).not.toHaveProperty("bootstrap");
    expect(store.getState()).not.toHaveProperty("controls");
    expect(store.getState()).not.toHaveProperty("workbenches");
  });

  it("无关 error 更新保留 catalog 引用", () => {
    const store = createDesktopStore();
    store.setState(
      {
        ...store.getState(),
        projects: [project],
        threadCatalogs: { [project.id]: [thread] },
      },
      true,
    );
    const projects = store.getState().projects;
    const threads = store.getState().threadCatalogs;

    dispatchDesktop(store, { type: "error", error: "failed" });

    expect(store.getState().projects).toBe(projects);
    expect(store.getState().threadCatalogs).toBe(threads);
  });
});
