import React, { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { TransportProvider } from "../src/renderer/src/runtime/session-transport-context.tsx";
import { DesktopCacheProviders } from "../src/renderer/src/state/desktop-cache-providers.tsx";
import { DraftSessionProvider } from "../src/renderer/src/state/draft-session-context.tsx";
import { SessionCacheProvider } from "../src/renderer/src/state/session-cache-context.tsx";

describe("draft runtime ownership", () => {
  it("mounts the draft runtime provider above Router-owned route content", () => {
    const routeContent = <div data-route-content />;
    const transport = DesktopCacheProviders({ children: routeContent });
    expect(transport.type).toBe(TransportProvider);

    const sessionCache = requiredElement(transport.props.children);
    expect(sessionCache.type).toBe(SessionCacheProvider);

    const draft = requiredElement(sessionCache.props.children);
    expect(draft.type).toBe(DraftSessionProvider);
    expect(draft.props.children).toBe(routeContent);
  });
});

function requiredElement(value: unknown) {
  if (!isValidElement<{ children?: unknown }>(value)) throw new Error("Expected a React element");
  return value;
}
