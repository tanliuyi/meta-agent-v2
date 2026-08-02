import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThreadSidebarDropZoneSkeleton } from "../src/renderer/src/components/layout/thread-sidebar-drop-zone-skeleton.tsx";

describe("ThreadSidebarDropZoneSkeleton", () => {
  it("渲染工作台结构化骨架", () => {
    const markup = renderToStaticMarkup(<ThreadSidebarDropZoneSkeleton />);

    expect(markup).toContain("thread-drop-zone-skeleton-header");
    expect(markup).toContain("thread-drop-zone-skeleton-body");
    expect(markup).toContain("thread-drop-zone-skeleton-group");
    expect(markup).toContain("thread-drop-zone-skeleton-footer");
    expect(markup).not.toContain("thread-drop-zone-skeleton-action");
    expect(markup).not.toContain("thread-drop-zone-skeleton-send");
  });
});
