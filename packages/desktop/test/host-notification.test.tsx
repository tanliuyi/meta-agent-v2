import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostNotification } from "../src/renderer/src/components/chat/host-notification.tsx";
import type { HostRequest } from "../src/shared/contracts.ts";

describe("HostNotification", () => {
  it("错误通知使用 assertive alert 与错误 tone", () => {
    const markup = renderToStaticMarkup(
      <HostNotification request={notification("error")} projectId="project" threadId="thread" />,
    );

    expect(markup).toContain('data-tone="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
  });

  it("普通通知使用 polite status", () => {
    const markup = renderToStaticMarkup(
      <HostNotification request={notification("info")} projectId="project" threadId="thread" />,
    );

    expect(markup).toContain('data-tone="info"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });
});

function notification(notifyType: NonNullable<HostRequest["notifyType"]>): HostRequest {
  return {
    id: `notify-${notifyType}`,
    type: "notify",
    title: `${notifyType} message`,
    notifyType,
    createdAt: 1,
  };
}
