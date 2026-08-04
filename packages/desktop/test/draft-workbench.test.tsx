import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftSessionScopeProvider } from "../src/renderer/src/components/draft-session-scope.tsx";
import { useSessionScope, useSessionWorkbenchTabs } from "../src/renderer/src/components/session-context.tsx";
import { TransportProvider } from "../src/renderer/src/runtime/session-transport-context.tsx";
import { DraftSessionProvider } from "../src/renderer/src/state/draft-session-context.tsx";
import {
  DRAFT_THREAD_ID,
  DraftWorkbenchProvider,
  useDraftWorkbench,
} from "../src/renderer/src/state/draft-workbench-context.tsx";
import { SessionCacheProvider } from "../src/renderer/src/state/session-cache-context.tsx";
import { WorkbenchTabProvider } from "../src/renderer/src/state/workbench-tab-context.tsx";

function WorkbenchProbe() {
  const { workbench } = useDraftWorkbench();
  return <div data-workbench={JSON.stringify(workbench)} />;
}

function ScopeProbe() {
  const { record, isDraft } = useSessionScope();
  return <div data-scope={JSON.stringify({ key: record.key, identity: record.identity, isDraft })} />;
}

function WorkbenchTabsProbe() {
  const { tabs, activeKey, openPanelTab } = useSessionWorkbenchTabs();
  return <div data-tabs={JSON.stringify({ tabs, activeKey, hasOpenPanelTab: typeof openPanelTab })} />;
}

/** 草稿页面完整 provider 栈：与 /new 路由一致（含 WorkbenchTabProvider 等窗口级 provider）。 */
function DraftProviderStack({ children }: { children: React.ReactNode }) {
  return (
    <TransportProvider>
      <SessionCacheProvider>
        <WorkbenchTabProvider>
          <DraftSessionProvider>
            <DraftWorkbenchProvider>{children}</DraftWorkbenchProvider>
          </DraftSessionProvider>
        </WorkbenchTabProvider>
      </SessionCacheProvider>
    </TransportProvider>
  );
}

describe("draft workbench", () => {
  it("初始 workbench 快照为页面级空状态（占位 threadId，无 tab）", () => {
    const markup = renderToStaticMarkup(
      <DraftProviderStack>
        <WorkbenchProbe />
      </DraftProviderStack>,
    );
    const probe = JSON.parse(extractAttr(markup, "data-workbench")) as {
      projectId: string;
      threadId: string;
      panelOpen: boolean;
      terminalOpen: boolean;
      tabs: unknown[];
      activeTabKey: unknown;
    };
    expect(probe.projectId).toBe("");
    expect(probe.threadId).toBe(DRAFT_THREAD_ID);
    expect(probe.panelOpen).toBe(false);
    expect(probe.terminalOpen).toBe(false);
    expect(probe.tabs).toEqual([]);
    expect(probe.activeTabKey).toBeNull();
  });

  it("草稿 scope 提供 isDraft 标记与占位 identity", () => {
    const markup = renderToStaticMarkup(
      <DraftProviderStack>
        <DraftSessionScopeProvider>
          <ScopeProbe />
        </DraftSessionScopeProvider>
      </DraftProviderStack>,
    );
    const probe = JSON.parse(extractAttr(markup, "data-scope")) as {
      key: string;
      identity: { projectId: string; threadId: string };
      isDraft: boolean;
    };
    expect(probe.isDraft).toBe(true);
    expect(probe.identity).toEqual({ projectId: "", threadId: DRAFT_THREAD_ID });
    expect(probe.key).toBe(`\u0000${DRAFT_THREAD_ID}`);
  });

  it("草稿 scope 下 useSessionWorkbenchTabs 返回草稿自身的 tab 状态（而非 session tab 表）", () => {
    const markup = renderToStaticMarkup(
      <DraftProviderStack>
        <DraftSessionScopeProvider>
          <WorkbenchTabsProbe />
        </DraftSessionScopeProvider>
      </DraftProviderStack>,
    );
    const probe = JSON.parse(extractAttr(markup, "data-tabs")) as {
      tabs: unknown[];
      activeKey: unknown;
      hasOpenPanelTab: string;
    };
    expect(probe.tabs).toEqual([]);
    expect(probe.activeKey).toBeNull();
    expect(probe.hasOpenPanelTab).toBe("function");
  });
});

function extractAttr(markup: string, attr: string): string {
  const match = markup.match(new RegExp(`${attr}="([^"]*)"`));
  if (!match) throw new Error(`missing ${attr}`);
  return match[1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}
