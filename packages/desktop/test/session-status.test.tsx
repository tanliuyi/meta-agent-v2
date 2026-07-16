import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionStatus } from "../src/renderer/src/components/chat/session-status.tsx";
import type { SessionControlState } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("SessionStatus", () => {
  it("显示运行中的权威活动状态", () => {
    const markup = renderToStaticMarkup(
      <SessionStatus snapshot={control({ running: true, workingVisible: true, workingMessage: "正在分析" })} />,
    );

    expect(markup).toContain("正在分析");
    expect(markup).toContain("session-status-row");
  });

  it("空闲且无错误时不渲染占位容器", () => {
    expect(renderToStaticMarkup(<SessionStatus snapshot={control()} />)).toBe("");
  });
});

function control(
  overrides: { running?: boolean; workingVisible?: boolean; workingMessage?: string } = {},
): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: 1,
    projectId: "project",
    threadId: "thread",
    title: "thread",
    cwd: "/workspace",
    running: overrides.running ?? false,
    compacting: false,
    queue: { steering: [], followUp: [] },
    models: [],
    commands: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    readiness: { state: "ready" },
    hostRequests: [],
    extensionUi: {
      statuses: {},
      workingVisible: overrides.workingVisible ?? false,
      workingMessage: overrides.workingMessage,
      toolsExpanded: false,
      widgets: [],
    },
  };
}
