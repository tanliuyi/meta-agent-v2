import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  cancel: vi.fn(),
  text: "queued follow-up",
}));

vi.mock("@assistant-ui/react", () => ({
  ComposerPrimitive: {
    Send: ({ children }: { children: ReactNode }) => children,
  },
  useAui: () => ({ composer: () => ({ cancel: runtime.cancel }) }),
  useAuiState: (selector: (state: { composer: { isEmpty: boolean; text: string } }) => unknown) =>
    selector({ composer: { isEmpty: runtime.text.trim().length === 0, text: runtime.text } }),
}));

vi.mock("../src/renderer/src/components/assistant-ui/tooltip-icon-button.tsx", () => ({
  TooltipIconButton: ({ children, tooltip }: { children: ReactNode; tooltip: string }) => (
    <button type="button">
      {children}
      <span>{tooltip}</span>
    </button>
  ),
}));

import { ComposerSubmitControl } from "../src/renderer/src/components/chat/composer/composer-submit-control.tsx";
import type { ComposerProps } from "../src/renderer/src/components/chat/composer/composer-types.ts";

const composer = {
  mode: "session",
  projectId: "project",
  threadId: "thread",
  model: undefined,
  models: [],
  commands: [],
  thinkingLevel: "off",
  thinkingLevels: [],
  readiness: { state: "ready" },
  phase: "running",
  queue: [],
  widgets: [],
  composerCommand: undefined,
  commandsReady: true,
  modelsLoading: false,
  onClearQueue: async () => undefined,
  onRefreshModels: async () => undefined,
  onSetModel: async () => undefined,
  onSetThinking: async () => undefined,
} satisfies Extract<ComposerProps, { mode: "session" }>;

describe("ComposerSubmitControl", () => {
  beforeEach(() => {
    runtime.cancel.mockClear();
    runtime.text = "queued follow-up";
  });

  it("运行中有文本时首次 Escape 仍将按钮切换为 Esc", () => {
    const markup = renderControl(true);

    expect(markup).toContain(">Esc<");
    expect(markup).toContain("再次按 Esc 停止运行");
    expect(markup).not.toContain("发送后续消息");
  });

  it("运行中有文本且未等待 Escape 确认时显示发送按钮", () => {
    const markup = renderControl(false);

    expect(markup).toContain("发送后续消息");
    expect(markup).not.toContain(">Esc<");
  });
});

function renderControl(escapeCancelPending: boolean): string {
  return renderToStaticMarkup(
    <ComposerSubmitControl
      composer={composer}
      disabled={false}
      configLoading={false}
      sending={false}
      isRunning={true}
      escapeCancelPending={escapeCancelPending}
      loading={false}
    />,
  );
}
