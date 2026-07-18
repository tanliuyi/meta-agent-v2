import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ThreadActivityIndicator } from "../src/renderer/src/components/chat/thread-activity-indicator.tsx";
import { piSessionBus } from "../src/renderer/src/runtime/pi-session-bus.ts";
import type { PiThreadSnapshot, SessionControlState } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("ThreadActivityIndicator", () => {
  beforeEach(() => setPhase("idle"));

  it("空闲且无错误时不渲染", () => {
    expect(renderToStaticMarkup(<ThreadActivityIndicator snapshot={control()} />)).toBe("");
  });

  it("明确显示会话压缩状态", () => {
    setPhase("compacting");

    const markup = renderToStaticMarkup(<ThreadActivityIndicator snapshot={control()} />);

    expect(markup).toContain("会话压缩中");
    expect(markup).toContain("animate-spin");
  });

  it("显示重试进度并默认收起错误详情", () => {
    setPhase("retrying");

    const markup = renderToStaticMarkup(
      <ThreadActivityIndicator
        snapshot={control({ retry: { attempt: 2, maxAttempts: 3, message: "provider unavailable" } })}
      />,
    );

    expect(markup).toContain("正在重试 2/3");
    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain("provider unavailable");
  });

  it("phase 已恢复运行时忽略滞留的 retry 和错误元数据", () => {
    setPhase("running");

    const markup = renderToStaticMarkup(
      <ThreadActivityIndicator
        snapshot={control({
          retry: { attempt: 1, maxAttempts: 3, message: "stale retry" },
          lastError: "stale error",
        })}
      />,
    );

    expect(markup).toBe("");
  });

  it("运行时显示扩展设置的 working message", () => {
    setPhase("running");
    const snapshot = control();
    snapshot.extensionUi.workingVisible = true;
    snapshot.extensionUi.workingMessage = "正在分析项目";

    const markup = renderToStaticMarkup(<ThreadActivityIndicator snapshot={snapshot} />);

    expect(markup).toContain("正在分析项目");
    expect(markup).toContain("animate-spin");
  });

  it("默认展开并警示最终错误", () => {
    const markup = renderToStaticMarkup(
      <ThreadActivityIndicator snapshot={control({ lastError: "provider failed" })} />,
    );

    expect(markup).toContain("运行出错");
    expect(markup).toContain("provider failed");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-state="open"');
  });
});

function setPhase(phase: PiThreadSnapshot["phase"]): void {
  piSessionBus.store.replace({
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId: "thread",
    cursor: 0,
    headId: null,
    nodes: [],
    queue: [],
    phase,
  });
}

function control(overrides: Pick<SessionControlState, "retry" | "lastError"> = {}): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: 1,
    projectId: "project",
    threadId: "thread",
    title: "thread",
    updatedAt: 1,
    cwd: "/workspace",
    running: false,
    ...overrides,
    queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
    models: [],
    commands: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    readiness: { state: "ready" },
    hostRequests: [],
    extensionUi: {
      statuses: {},
      workingVisible: false,
      editorRevision: 0,
      toolsExpanded: false,
      widgets: [],
    },
  };
}
