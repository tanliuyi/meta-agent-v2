import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRoutePending } from "../src/renderer/src/components/session-route-pending.tsx";
import { LayoutProvider } from "../src/renderer/src/state/layout.tsx";

beforeEach(() => {
  vi.stubGlobal("window", { desktop: { platform: "win32" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session route pending surface", () => {
  it("keeps loading inside the workspace with a composer skeleton", () => {
    const markup = renderToStaticMarkup(createElement(LayoutProvider, null, createElement(SessionRoutePending)));

    expect(markup).toContain("workspace-row");
    expect(markup).toContain("session-bootstrap-composer");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("shell-runtime-overlay");
    expect(markup).not.toContain('role="dialog"');
  });
});
