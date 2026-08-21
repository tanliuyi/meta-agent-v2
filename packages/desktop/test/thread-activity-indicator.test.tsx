import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  isThreadActivityVisible,
  ThreadActivityIndicator,
} from "../src/renderer/src/components/chat/thread-activity-indicator.tsx";
import type { PiThreadPhase, SessionControlState } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("ThreadActivityIndicator", () => {
  it("只为可见状态分配 timeline 尾项", () => {
    expect(isThreadActivityVisible("idle", undefined)).toBe(false);
    expect(isThreadActivityVisible("running", undefined)).toBe(true);
    expect(isThreadActivityVisible("retrying", undefined)).toBe(true);
    expect(isThreadActivityVisible("compacting", undefined)).toBe(true);
    expect(isThreadActivityVisible("idle", "provider failed")).toBe(true);
  });

  it("空闲且无错误时不渲染", () => {
    expect(renderIndicator("idle")).toBe("");
  });

  it("明确显示会话压缩状态", () => {
    const markup = renderIndicator("compacting");

    expect(markup).toContain('aria-live="polite"');
  });

  it("显示重试进度并默认收起错误详情", () => {
    const markup = renderIndicator("retrying", {
      retry: { attempt: 2, maxAttempts: 3, message: "provider unavailable" },
    });

    expect(markup).not.toContain("provider unavailable");
  });

  it("显示运行状态并忽略滞留的 retry 和错误元数据", () => {
    const markup = renderIndicator("running", {
      retry: { attempt: 1, maxAttempts: 3, message: "stale retry" },
      lastError: "stale error",
    });

    expect(markup).toContain("运行中");
    expect(markup).toContain('data-slot="dot-matrix"');
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain('class="shimmer ');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("stale retry");
    expect(markup).not.toContain("stale error");
  });

  it("默认展开并警示最终错误", () => {
    const markup = renderIndicator("idle", { lastError: "provider failed" });

    expect(markup).toContain("provider failed");
    expect(markup).toContain('role="alert"');
  });
});

function renderIndicator(
  phase: PiThreadPhase,
  overrides: Pick<SessionControlState, "retry" | "lastError"> = {},
): string {
  const snapshot = control(overrides);
  return renderToStaticMarkup(
    <ThreadActivityIndicator phase={phase} retry={snapshot.retry} lastError={snapshot.lastError} />,
  );
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
    extensionHost: { statuses: {}, widgets: [] },
  };
}
