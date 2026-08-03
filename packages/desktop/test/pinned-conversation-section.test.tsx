import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PinnedConversationSection,
  planPinnedCatalogLoads,
} from "../src/renderer/src/components/layout/pinned-conversation-section.tsx";
import { pinnedThreadKey } from "../src/renderer/src/state/thread-pinning-preference.ts";
import type { Project, Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "Project",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

const thread: Thread = {
  id: "pinned-thread",
  projectId: project.id,
  title: "Pinned thread",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 1,
  preview: "",
  archived: false,
  running: false,
};

const { mockState, mockPinnedThreadKeys, loadProjectThreads } = vi.hoisted(() => {
  const mockState = {
    projects: [] as Project[],
    threadCatalogs: {} as Record<string, Thread[]>,
  };
  const mockPinnedThreadKeys = new Set<string>();
  const loadProjectThreads = vi.fn(async () => undefined);
  return { mockState, mockPinnedThreadKeys, loadProjectThreads };
});

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopSelector: (selector: (state: typeof mockState) => unknown) => selector(mockState),
  useDesktopActions: () => ({ loadProjectThreads }),
}));

vi.mock("../src/renderer/src/state/thread-pinning-context.tsx", () => ({
  useThreadPinning: () => ({
    pinnedThreadKeys: mockPinnedThreadKeys,
    toggleThread: vi.fn(),
  }),
}));

vi.mock("../src/renderer/src/components/layout/desktop-thread-list.tsx", () => ({
  DesktopThreadList: () => <ul data-slot="thread-list" />,
}));

describe("planPinnedCatalogLoads", () => {
  const pinned = new Set([project.id]);

  it("requires no load when there are no pinned projects", () => {
    expect(planPinnedCatalogLoads([project], new Set(), {}, new Set())).toEqual({
      needsLoad: [],
      waiting: false,
      failed: false,
    });
  });

  it("requires no load once the catalog is loaded", () => {
    expect(planPinnedCatalogLoads([project], pinned, { [project.id]: [thread] }, new Set())).toEqual({
      needsLoad: [],
      waiting: false,
      failed: false,
    });
  });

  it("waits while a pinned catalog is still loading", () => {
    expect(planPinnedCatalogLoads([project], pinned, {}, new Set())).toEqual({
      needsLoad: [project.id],
      waiting: true,
      failed: false,
    });
  });

  it("marks a rejected catalog load as failed instead of waiting forever", () => {
    expect(planPinnedCatalogLoads([project], pinned, {}, new Set([project.id]))).toEqual({
      needsLoad: [project.id],
      waiting: false,
      failed: true,
    });
  });

  it("returns to the waiting state after a retry clears the failure", () => {
    const failed = planPinnedCatalogLoads([project], pinned, {}, new Set([project.id]));
    const retried = planPinnedCatalogLoads([project], pinned, {}, new Set());
    expect(failed.failed).toBe(true);
    expect(retried.waiting).toBe(true);
    expect(retried.failed).toBe(false);
  });
});

describe("PinnedConversationSection failure state", () => {
  it("renders nothing without pinned projects", () => {
    mockState.projects = [project];
    mockState.threadCatalogs = {};
    mockPinnedThreadKeys.clear();

    expect(renderToStaticMarkup(<PinnedConversationSection />)).toBe("");
  });

  it("shows the loading status while a pinned catalog is pending", () => {
    mockState.projects = [project];
    mockState.threadCatalogs = {};
    mockPinnedThreadKeys.clear();
    mockPinnedThreadKeys.add(pinnedThreadKey("project", "pinned-thread"));

    const markup = renderToStaticMarkup(<PinnedConversationSection />);
    expect(markup).toContain("加载置顶会话");
    expect(markup).not.toContain("加载失败");
  });

  it("renders pinned groups once catalogs are loaded", () => {
    mockState.projects = [project];
    mockState.threadCatalogs = { [project.id]: [thread] };
    mockPinnedThreadKeys.clear();
    mockPinnedThreadKeys.add(pinnedThreadKey("project", "pinned-thread"));

    const markup = renderToStaticMarkup(<PinnedConversationSection />);
    expect(markup).toContain("Project");
    expect(markup).toContain('data-slot="thread-list"');
  });
});
