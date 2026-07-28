import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopThreadListItem } from "../src/renderer/src/components/layout/desktop-thread-list-item.tsx";
import type { Thread } from "../src/shared/contracts.ts";

const baseThread: Thread = {
  id: "child",
  projectId: "project",
  title: "Inspect the renderer tree",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "Inspect the renderer tree",
  archived: false,
  running: false,
  parentThreadId: "parent",
  origin: "subagent",
  agentName: "reviewer",
};

function renderThread(
  thread: Thread,
  options: { depth?: number; childCount?: number; compactRoot?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <DesktopThreadListItem
      thread={thread}
      active={false}
      isSwitching={false}
      isRenamingPending={false}
      isArchivePending={false}
      isDeletePending={false}
      depth={options.depth ?? 1}
      childCount={options.childCount ?? 0}
      expanded={false}
      ancestorContinuations={[]}
      isLastChild
      compactRoot={options.compactRoot}
      onToggle={vi.fn()}
      onRenameStart={vi.fn()}
      onOpen={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onPrewarm={vi.fn()}
    />,
  );
}

describe("DesktopThreadListItem", () => {
  it("renders the subagent name separately from the task title", () => {
    const markup = renderThread(baseThread);

    expect(markup).toContain('data-slot="subagent-name"');
    expect(markup).toContain(">reviewer</span>");
    expect(markup).toContain('data-slot="thread-title"');
    expect(markup).toContain(">Inspect the renderer tree</span>");
  });

  it("keeps legacy subagent sessions readable without an agent name", () => {
    const markup = renderThread({ ...baseThread, agentName: undefined });

    expect(markup).not.toContain('data-slot="subagent-name"');
    expect(markup).toContain(">Inspect the renderer tree</span>");
  });

  it("aligns compact root threads unless they own child sessions", () => {
    const rootThread = { ...baseThread, parentThreadId: undefined, origin: undefined, agentName: undefined };

    expect(renderThread(rootThread, { depth: 0, compactRoot: true })).toContain("padding-inline-start:8px");
    expect(renderThread(rootThread, { depth: 0, childCount: 1, compactRoot: true })).toContain(
      "padding-inline-start:32px",
    );
  });
});
