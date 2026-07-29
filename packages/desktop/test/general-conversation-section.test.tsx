import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  GeneralConversationSection,
  reduceGeneralConversationLoad,
} from "../src/renderer/src/components/layout/general-conversation-section.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { DesktopActions } from "../src/renderer/src/state/desktop-actions.ts";
import { DesktopActionsContext } from "../src/renderer/src/state/desktop-context.tsx";
import { DesktopStoreProvider } from "../src/renderer/src/state/desktop-store-context.tsx";
import { GENERAL_WORKSPACE_ID } from "../src/shared/contracts.ts";

describe("GeneralConversationSection", () => {
  it("默认展开并在标题右侧提供新建对话按钮", () => {
    const markup = renderSection();

    expect(markup).toContain("对话");
    expect(markup.indexOf("<span>对话</span>")).toBeLessThan(markup.indexOf("lucide-chevron-down"));
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="新建对话"');
    expect(markup).toContain('id="general-conversation-threads"');
    expect(markup).not.toContain(
      'id="general-conversation-threads" class="sidebar-projects sidebar-conversation-list" role="region" aria-label="对话会话列表" hidden=""',
    );
  });

  it("加载失败后重试会恢复为可再次请求状态", () => {
    const failed = reduceGeneralConversationLoad(
      reduceGeneralConversationLoad({ attempted: false, failed: false }, { type: "started" }),
      { type: "failed" },
    );

    expect(failed).toEqual({ attempted: true, failed: true });
    expect(reduceGeneralConversationLoad(failed, { type: "retry" })).toEqual({ attempted: false, failed: false });
  });

  it("首帧恢复持久化的收起状态", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({ version: 1, projects: [[GENERAL_WORKSPACE_ID, false]] }),
      },
    });

    try {
      const markup = renderSection();
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).toContain('id="general-conversation-threads"');
      expect(markup).toContain('hidden=""');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function renderSection(): string {
  return renderToStaticMarkup(
    <DesktopStoreProvider>
      <DesktopActionsContext.Provider value={desktopActions()}>
        <TooltipProvider>
          <GeneralConversationSection active={false} newConversationDisabled={false} onNewConversation={vi.fn()} />
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
