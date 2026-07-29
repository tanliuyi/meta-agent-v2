import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionRoutePending } from "../src/renderer/src/components/session-route-pending.tsx";

describe("session route pending surface", () => {
  it("keeps loading inside the workspace with a composer skeleton", () => {
    const markup = renderToStaticMarkup(createElement(SessionRoutePending));

    expect(markup).toContain("workspace-row");
    expect(markup).toContain("session-bootstrap-composer");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("node-runtime-overlay");
    expect(markup).not.toContain('role="dialog"');
  });
});
