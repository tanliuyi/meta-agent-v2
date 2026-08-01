import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionSurface } from "../src/renderer/src/components/session-surface.tsx";

vi.mock("../src/renderer/src/components/chat/chat-thread.tsx", () => ({
  ChatThread: () => <div data-slot="messages" />,
}));
vi.mock("../src/renderer/src/components/layout/topbar.tsx", () => ({
  Topbar: () => <header data-slot="topbar" />,
}));
vi.mock("../src/renderer/src/components/panel/terminal/bottom-terminal.tsx", () => ({
  BottomTerminal: () => <section data-slot="bottom" />,
}));
vi.mock("../src/renderer/src/components/panel/workbench-panel.tsx", () => ({
  WorkbenchPanel: () => <aside data-slot="panel" />,
}));
vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({ record: { key: "session-1" }, active: true }),
}));

describe("SessionSurface layout", () => {
  it("renders the workbench as a workspace column beside all three primary rows", () => {
    const markup = renderToStaticMarkup(React.createElement(SessionSurface));

    expect(markup).toContain(
      '<header data-slot="topbar"></header><div class="workspace-row session-surface" data-session-key="session-1" data-active="true"><main class="chat-workspace"><div data-slot="messages"></div></main></div><section data-slot="bottom"></section><aside data-slot="panel"></aside>',
    );
  });
});
