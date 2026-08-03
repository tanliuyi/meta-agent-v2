import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchTabList } from "../src/renderer/src/components/panel/panel-tab.tsx";
import type { WorkbenchTab } from "../src/shared/contracts.ts";

const agentTab: WorkbenchTab = {
  kind: "session",
  key: "project:agent-session",
  projectId: "project",
  threadId: "agent-session",
  agentName: "executor",
  displayName: "执行者",
};

function renderTab(running: boolean): string {
  return renderToStaticMarkup(
    <WorkbenchTabList
      tabs={[agentTab]}
      activeKey={agentTab.key}
      runningThreadIds={running ? new Set([agentTab.threadId]) : new Set()}
      onActivate={vi.fn()}
      onCloseTab={vi.fn()}
    />,
  );
}

describe("WorkbenchTabList", () => {
  it("为运行中的智能体 tab 标记动画和忙碌状态", () => {
    const markup = renderTab(true);

    expect(markup).toContain('class="panel-tab-agent-icon" data-running="true"');
    expect(markup).toContain('aria-busy="true"');
  });

  it("普通会话运行时不使用智能体动画", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTabList
        tabs={[{ ...agentTab, agentName: undefined }]}
        activeKey={agentTab.key}
        runningThreadIds={new Set([agentTab.threadId])}
        onActivate={vi.fn()}
        onCloseTab={vi.fn()}
      />,
    );

    expect(markup).not.toContain("panel-tab-agent-icon");
    expect(markup).not.toContain('aria-busy="true"');
  });

  it("智能体空闲时不标记运行状态", () => {
    const markup = renderTab(false);

    expect(markup).not.toContain('data-running="true"');
    expect(markup).not.toContain('aria-busy="true"');
  });
});
