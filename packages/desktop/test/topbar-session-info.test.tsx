import { readFileSync } from "node:fs";
import React, { type ButtonHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/src/components/assistant-ui/tooltip-icon-button.tsx", () => ({
  TooltipIconButton: ({
    children,
    side: _side,
    size: _size,
    tooltip: _tooltip,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: ReactNode;
    side?: string;
    size?: string;
    tooltip?: string;
    variant?: string;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionControlSelector: (selector: (control: { extensionHost: { windowTitle: string } }) => unknown) =>
    selector({ extensionHost: { windowTitle: "Current session" } }),
  useSessionWorkbenchSelector: (selector: (workbench: object) => unknown) => selector({}),
}));

vi.mock("../src/renderer/src/components/layout/sidebar-toggle.tsx", () => ({
  SidebarToggle: () => <button type="button" data-slot="sidebar-toggle" />,
}));

vi.mock("../src/renderer/src/components/layout/workbench-controls.tsx", () => ({
  WorkbenchControls: () => <div data-slot="workbench-controls" />,
}));

import { Topbar } from "../src/renderer/src/components/layout/topbar.tsx";

const layoutCss = readFileSync(new URL("../src/renderer/src/styles/layout.css", import.meta.url), "utf8");
const panelCss = readFileSync(new URL("../src/renderer/src/styles/panel.css", import.meta.url), "utf8");

describe("Topbar session info toggle", () => {
  it("keeps the toggle in the session topbar instead of the fixed global actions", () => {
    const markup = renderToStaticMarkup(<Topbar sessionInfoOpen={true} onToggleSessionInfo={() => undefined} />);

    expect(markup).toMatch(
      /<header class="topbar">.*class="session-info-toggle size-6".*<div class="topbar-actions"><div data-slot="workbench-controls"><\/div><\/div><\/header>/s,
    );
  });

  it("keeps the toggle clear of global actions while the workbench is collapsed", () => {
    expect(layoutCss).toMatch(
      /\.workspace:has\(> \.workbench-panel\[data-collapsed\]\) \.session-info-toggle\s*\{[^}]*margin-right:\s*56px;/s,
    );
  });

  it("uses the shared panel action spacing on every desktop platform", () => {
    expect(panelCss).toMatch(/\.panel-tabs\s*\{[^}]*padding:\s*0 66px 0 8px;/s);
    expect(panelCss).toMatch(/\.panel-tabs-safe-area\s*\{[^}]*width:\s*66px;/s);
    expect(panelCss).not.toMatch(/data-platform="darwin"/);
  });
});
