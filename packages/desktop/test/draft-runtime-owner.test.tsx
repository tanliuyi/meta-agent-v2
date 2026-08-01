import React, { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { TransportProvider } from "../src/renderer/src/runtime/session-transport-context.tsx";
import { DesktopCacheProviders } from "../src/renderer/src/state/desktop-cache-providers.tsx";
import { DraftSessionProvider } from "../src/renderer/src/state/draft-session-context.tsx";
import { SessionCacheProvider } from "../src/renderer/src/state/session-cache-context.tsx";
import { SessionDraftProvider } from "../src/renderer/src/state/session-draft-context.tsx";
import { WorkbenchTabProvider } from "../src/renderer/src/state/workbench-tab-context.tsx";

describe("draft runtime ownership", () => {
  it("mounts the draft runtime providers above Router-owned route content", () => {
    const routeContent = <div data-route-content />;
    const transport = DesktopCacheProviders({ children: routeContent });
    expect(transport.type).toBe(TransportProvider);

    const sessionCache = requiredElement(transport.props.children);
    expect(sessionCache.type).toBe(SessionCacheProvider);

    // workbench tab 状态按主 session 隔离存储，provider 依赖 session cache 记录。
    const workbenchTabs = requiredElement(sessionCache.props.children);
    expect(workbenchTabs.type).toBe(WorkbenchTabProvider);

    // 路由级新会话草稿：窗口级共享，跨路由卸载保留。
    const routeDraft = requiredElement(workbenchTabs.props.children);
    expect(routeDraft.type).toBe(DraftSessionProvider);

    // workbench 草稿按主 session 隔离，provider 位于路由内容之上。
    const sessionDraft = requiredElement(routeDraft.props.children);
    expect(sessionDraft.type).toBe(SessionDraftProvider);
    expect(sessionDraft.props.children).toBe(routeContent);
  });
});

function requiredElement(value: unknown) {
  if (!isValidElement<{ children?: unknown }>(value)) throw new Error("Expected a React element");
  return value;
}
