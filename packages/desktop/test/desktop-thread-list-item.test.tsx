import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopThreadListItem,
  threadHoverPreview,
} from "../src/renderer/src/components/layout/desktop-thread-list-item.tsx";
import type { PiAssistantMessage, PiThreadSnapshot, Thread } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

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

function assistantNode(
  id: string,
  parentId: string,
  text: string,
  status: PiAssistantMessage["status"],
): PiAssistantMessage {
  return {
    id,
    parentId,
    createdAt: 3,
    kind: "assistant",
    content: [{ id: `${id}-text`, type: "text", text }],
    status,
    provenance: { api: "test", provider: "test", model: "test" },
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  };
}

function renderThread(
  thread: Thread,
  options: {
    depth?: number;
    childCount?: number;
    runningChildCount?: number;
    compactRoot?: boolean;
    active?: boolean;
    pinned?: boolean;
    shortcutHint?: number;
  } = {},
): string {
  return renderToStaticMarkup(
    <DesktopThreadListItem
      thread={thread}
      active={options.active ?? false}
      isSwitching={false}
      isRenamingPending={false}
      isStopPending={false}
      isArchivePending={false}
      isDeletePending={false}
      isPromotePending={false}
      isPinned={options.pinned}
      shortcutHint={options.shortcutHint}
      depth={options.depth ?? 1}
      childCount={options.childCount ?? 0}
      runningChildCount={options.runningChildCount ?? 0}
      expanded={false}
      ancestorContinuations={[]}
      isLastChild
      compactRoot={options.compactRoot}
      onToggle={vi.fn()}
      onRenameStart={vi.fn()}
      onStop={vi.fn()}
      onOpen={vi.fn()}
      onOpenInSidebar={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onPromote={vi.fn()}
      onTogglePin={vi.fn()}
    />,
  );
}

describe("DesktopThreadListItem", () => {
  it("keeps the latest stable reply until the streaming reply completes", () => {
    const runningAssistant = assistantNode("running-assistant", "notice", "正在生成\n第二行\n不应显示", {
      type: "running",
    });
    const snapshot: PiThreadSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "child",
      cursor: 5,
      headId: runningAssistant.id,
      queue: [],
      phase: "running",
      thinkingLevel: "off",
      nodes: [
        {
          id: "stable-user",
          parentId: null,
          createdAt: 1,
          kind: "user",
          content: [{ type: "text", text: "上一轮问题" }],
          delivery: { state: "persisted" },
        },
        assistantNode("stable-assistant", "stable-user", "稳定回复", {
          type: "complete",
          reason: "stop",
        }),
        {
          id: "current-user",
          parentId: "stable-assistant",
          createdAt: 3,
          kind: "user",
          content: [{ type: "text", text: "最新问题\n补充内容\n不应显示" }],
          delivery: { state: "persisted" },
        },
        {
          id: "notice",
          parentId: "current-user",
          createdAt: 4,
          kind: "notice",
          noticeType: "bash",
          title: "Bash 输出",
          content: { type: "text", text: "ignored" },
        },
        runningAssistant,
      ],
    };

    expect(threadHoverPreview(snapshot)).toEqual({
      loaded: true,
      user: "上一轮问题",
      assistant: "稳定回复",
    });

    expect(
      threadHoverPreview({
        ...snapshot,
        phase: "idle",
        nodes: [
          ...snapshot.nodes.slice(0, -1),
          {
            ...runningAssistant,
            status: { type: "complete", reason: "stop" },
          },
        ],
      }),
    ).toEqual({
      loaded: true,
      user: "最新问题\n补充内容",
      assistant: "正在生成\n第二行",
    });
  });

  it("uses catalog fallback until the lazy timeline has loaded", () => {
    expect(
      threadHoverPreview({
        protocolVersion: PROTOCOL_VERSION,
        projectId: "",
        threadId: "",
        cursor: 0,
        headId: null,
        nodes: [],
        queue: [],
        phase: "idle",
        thinkingLevel: "off",
      }),
    ).toEqual({ loaded: false, user: "", assistant: "" });
  });

  it("renders the localized built-in subagent name separately from the task title", () => {
    const markup = renderThread(baseThread);

    expect(markup).toContain('data-slot="subagent-name"');
    expect(markup).toContain('data-variant="muted"');
    expect(markup).toContain('data-size="sm"');
    expect(markup).toContain('title="reviewer"');
    expect(markup).toContain(">审查员</span>");
    expect(markup).toContain('data-slot="thread-title"');
    expect(markup).toContain(">Inspect the renderer tree</span>");
  });

  it("renders the row as a draggable sidebar-session source with a drag image", () => {
    const markup = renderThread(baseThread);

    expect(markup).toContain('draggable="true"');
    expect(markup).toContain('class="thread-drag-image"');
    expect(markup).toContain(">在侧边栏打开</span>");
  });

  it("marks pinned sessions and exposes the unpin action", () => {
    const markup = renderThread(baseThread, { pinned: true });

    expect(markup).toContain('aria-label="已置顶"');
  });

  it("keeps custom subagent names unchanged", () => {
    const markup = renderThread({
      ...baseThread,
      agentName: "security-review",
    });

    expect(markup).toContain(">security-review</span>");
  });

  it("keeps legacy subagent sessions readable without an agent name", () => {
    const markup = renderThread({ ...baseThread, agentName: undefined });

    expect(markup).not.toContain('data-slot="subagent-name"');
    expect(markup).toContain(">Inspect the renderer tree</span>");
  });

  it("shows the matching header tab shortcut hint in place of the loading status", () => {
    const markup = renderThread({ ...baseThread, running: true }, { shortcutHint: 3 });

    expect(markup).toContain('class="desktop-thread-shortcut-hint"');
    expect(markup).toContain(">3</span>");
    expect(markup).not.toContain("running-dot");
  });

  it("shows only the number of running child sessions", () => {
    const markup = renderThread(baseThread, {
      childCount: 6,
      runningChildCount: 2,
    });

    expect(markup).toContain('aria-label="2 个子会话正在运行"');
    expect(markup).toContain(">2</span>");
    expect(markup).not.toContain(">6</span>");
  });

  it("hides the child count when no child session is running", () => {
    const markup = renderThread(baseThread, { childCount: 6 });

    expect(markup).not.toContain("个子会话正在运行");
    expect(markup).not.toContain(">6</span>");
    expect(markup).toContain('aria-label="展开子会话"');
  });

  it("aligns compact root threads unless they own child sessions", () => {
    const rootThread = {
      ...baseThread,
      parentThreadId: undefined,
      origin: undefined,
      agentName: undefined,
    };

    expect(renderThread(rootThread, { depth: 0, compactRoot: true })).toContain("padding-inline-start:8px");
    expect(renderThread(rootThread, { depth: 0, childCount: 1, compactRoot: true })).toContain(
      "padding-inline-start:32px",
    );
  });

  it("shows the completion dot for a finished run that was not viewed yet", () => {
    const markup = renderThread({ ...baseThread, completed: true });

    expect(markup).toContain('class="completed-dot"');
    expect(markup).toContain('aria-label="运行已完成"');
  });

  it("hides the completion dot while the thread is running or active", () => {
    expect(renderThread({ ...baseThread, completed: true, running: true })).not.toContain("completed-dot");
    expect(renderThread({ ...baseThread, completed: true }, { active: true })).not.toContain("completed-dot");
  });

  it("hides the completion dot for a thread without a finished run", () => {
    expect(renderThread(baseThread)).not.toContain("completed-dot");
  });
});
