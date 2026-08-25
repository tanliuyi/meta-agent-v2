import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const timeline = {
  phase: "running",
  nodes: [
    { kind: "user", createdAt: Date.UTC(2025, 0, 2, 3, 4) },
    { kind: "assistant", createdAt: Date.UTC(2025, 0, 2, 3, 5) },
    { kind: "tool", createdAt: Date.UTC(2025, 0, 2, 3, 6) },
  ],
};

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionConnection: () => "ready",
  useSessionControl: () => ({
    context: { tokens: 117_800, contextWindow: 272_000, percent: 43.3 },
    cwd: "G:/workspace/meta-agent-v2",
    model: { id: "gpt-5.6-solo", name: "GPT 5.6 Solo", provider: "home-gateway" },
    thinkingLevel: "medium",
    updatedAt: Date.UTC(2025, 0, 2, 3, 7),
  }),
  useSessionIdentity: () => ({ projectId: "project-1", threadId: "thread-1" }),
  useSessionTimelineSelector: (selector: (value: typeof timeline) => unknown) => selector(timeline),
}));

import { SessionInfo } from "../src/renderer/src/components/chat/session-info.tsx";

const css = readFileSync(
  fileURLToPath(new URL("../src/renderer/src/styles/session-info.css", import.meta.url)),
  "utf8",
);
const messagesSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/src/components/chat/messages.tsx", import.meta.url)),
  "utf8",
);
const threadSource = readFileSync(
  fileURLToPath(new URL("../src/renderer/src/components/chat/session-chat-thread.tsx", import.meta.url)),
  "utf8",
);

describe("SessionInfo", () => {
  it("renders the current session basics", () => {
    const markup = renderToStaticMarkup(<SessionInfo open />);

    expect(markup).toContain('id="session-info-panel"');
    expect(markup).toContain('data-open="true"');
    expect(markup).toContain("已连接 · 运行中");
    expect(markup).toContain("GPT 5.6 Solo (home-gateway/gpt-5.6-solo)");
    expect(markup).toContain("117.8k / 272k (43%)");
    expect(markup).toContain("2 条");
    expect(markup).toContain("G:/workspace/meta-agent-v2");
    expect(markup).toContain("thread-1");
    expect(markup).toContain("project-1");
  });

  it("keeps the collapsed panel mounted but hidden from the accessibility tree", () => {
    const markup = renderToStaticMarkup(<SessionInfo open={false} />);

    expect(markup).toContain('data-open="false"');
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("session info layout", () => {
  it("reserves a layout region while keeping the message column centered inside it", () => {
    const openLayoutRule =
      css.match(
        /\.chat-workspace\[data-session-info-open\] \[data-slot="session-message-layout"\],\s*\.chat-workspace\[data-session-info-open\] \[data-slot="session-composer-footer"\]\s*\{([^}]*)\}/s,
      )?.[1] ?? "";

    expect(openLayoutRule).toMatch(/margin-right:\s*calc\(var\(--session-info-panel-width\) \+ 24px\)/);
    expect(openLayoutRule).not.toMatch(/\bwidth\s*:/);
    expect(messagesSource).toMatch(
      /data-slot="session-message-layout">\s*<div\s+ref=\{contentRef\}\s+data-slot="session-message-content"\s+className="mx-auto w-full max-w-\(--layout-thread-max-width\)"/s,
    );
    expect(threadSource).toMatch(
      /data-slot="session-composer-footer"\s+className="shrink-0 [^"]+"[\s\S]*data-slot="session-composer-content" className="mx-auto w-full max-w-\(--layout-thread-max-width\)/,
    );
    expect(css).not.toMatch(/data-session-info-open[^}]*\.thread-root[^}]*margin-right/s);
    expect(css).not.toMatch(/data-session-info-open[^}]*aui_thread-viewport[^}]*margin-right/s);
  });

  it("uses overlay mode when the session workspace cannot fit the panel beside the thread", () => {
    const workspaceRule = css.match(/^\s*\.chat-workspace\s*\{([^}]*)\}/m)?.[1] ?? "";
    const narrowLayoutRule =
      css.match(
        /@container session-workspace \(max-width: 1153px\)\s*\{\s*\.chat-workspace\[data-session-info-open\] \[data-slot="session-message-layout"\],\s*\.chat-workspace\[data-session-info-open\] \[data-slot="session-composer-footer"\]\s*\{([^}]*)\}/s,
      )?.[1] ?? "";

    expect(workspaceRule).toMatch(/container-name:\s*session-workspace/);
    expect(workspaceRule).toMatch(/container-type:\s*inline-size/);
    expect(narrowLayoutRule).toMatch(/margin-right:\s*0/);
  });

  it("anchors an animated, content-height panel at the session top-right", () => {
    const panelRule = css.match(/^\s*\.session-info-panel\s*\{([^}]*)\}/m)?.[1] ?? "";

    expect(panelRule).toMatch(/position:\s*absolute/);
    expect(panelRule).toMatch(/top:\s*12px/);
    expect(panelRule).toMatch(/right:\s*12px/);
    expect(panelRule).toMatch(/max-height:\s*calc\(100% - 24px\)/);
    expect(panelRule).toMatch(/overflow:\s*hidden auto/);
    expect(panelRule).toMatch(/transform-origin:\s*calc\(100% - 10px\) -34px/);
    expect(panelRule).not.toMatch(/(?:^|\n)\s*height\s*:/);
    expect(css).toMatch(/\.session-info-panel\[data-open="true"\]\s*\{[^}]*transform:\s*scale\(1\)/s);
  });
});
