import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionControlState } from "../src/shared/contracts.ts";

const state = vi.hoisted(() => ({
  control: null as SessionControlState | null,
  phase: "running",
  queue: [] as unknown[],
  pluginEnabledCalls: [] as boolean[],
}));

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopActions: () => ({ stopThread: vi.fn(async () => undefined) }),
}));

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({
    record: { identity: { projectId: "project", threadId: "thread" } },
    clearQueue: vi.fn(),
    commandsReady: true,
    modelsRefreshing: false,
    refreshModels: vi.fn(),
    setModel: vi.fn(),
    setThinking: vi.fn(),
  }),
  useSessionControlSelector: (selector: (control: SessionControlState | null) => unknown) => selector(state.control),
  useSessionTimelineSelector: (selector: (timeline: { phase: string; queue: unknown[] }) => unknown) =>
    selector({ phase: state.phase, queue: state.queue }),
}));

vi.mock("../src/renderer/src/components/chat/use-session-plugins.ts", () => ({
  useSessionPlugins: (_projectId: string, _threadId: string, enabled: boolean) => {
    state.pluginEnabledCalls.push(enabled);
    return {
      plugins: [],
      enabledPluginIds: [],
      loading: false,
      applying: false,
      pendingAbortSelection: null,
      clearError: vi.fn(),
      apply: vi.fn(async () => undefined),
      clearPendingAbort: vi.fn(),
      applyConfirmedAbort: vi.fn(async () => undefined),
    };
  },
}));

vi.mock("../src/renderer/src/components/chat/composer/composer.tsx", () => ({
  Composer: () => <div data-component="composer" />,
}));

vi.mock("../src/renderer/src/components/chat/host-request-dialog.tsx", () => ({
  HostRequestDialog: () => <div data-component="host-request" />,
}));

vi.mock("../src/renderer/src/components/chat/session-read-only-status.tsx", () => ({
  ReadOnlySessionStatus: () => <div data-component="read-only" />,
}));

vi.mock("../src/renderer/src/components/shared/ui/confirm-dialog.tsx", () => ({
  ConfirmDialog: () => null,
}));

import { SessionComposer } from "../src/renderer/src/components/chat/session-composer.tsx";

function control(interaction: SessionControlState["interaction"]): SessionControlState {
  return {
    protocolVersion: 10,
    revision: 1,
    projectId: "project",
    threadId: "thread",
    title: "Thread",
    updatedAt: 1,
    cwd: "/tmp/project",
    running: true,
    interaction,
    queueModes: { steering: "all", followUp: "all" },
    models: [],
    commands: [],
    context: undefined,
    thinkingLevel: "off",
    thinkingLevels: [],
    readiness: { state: "ready" },
    extensionSet: { generation: "test", diagnostics: [], reloadRequired: false },
    extensionHost: { statuses: {}, widgets: [] },
    hostRequests: [
      {
        id: "request",
        type: "confirm",
        title: "Confirm",
        createdAt: 1,
      },
    ],
  } as SessionControlState;
}

describe("SessionComposer host requests", () => {
  beforeEach(() => {
    state.control = null;
    state.pluginEnabledCalls = [];
  });

  it("shows host requests in read-only subagent sessions", () => {
    state.control = control("read-only");

    const markup = renderToStaticMarkup(<SessionComposer />);

    expect(markup).toContain('data-component="host-request"');
    expect(markup).not.toContain('data-component="read-only"');
    expect(state.pluginEnabledCalls).toEqual([false]);
  });

  it("keeps the editable Composer mounted and inert while a host request is active", () => {
    state.control = control("read-write");

    const markup = renderToStaticMarkup(<SessionComposer />);

    expect(markup).toContain('data-component="host-request"');
    expect(markup).toContain('data-component="composer"');
    expect(markup).toContain("hidden");
    expect(markup).toContain("inert");
  });

  it("uses the same Composer container before and during a host request", () => {
    state.control = { ...control("read-write"), hostRequests: [] };
    const withoutRequest = renderToStaticMarkup(<SessionComposer />);

    state.control = control("read-write");
    const withRequest = renderToStaticMarkup(<SessionComposer />);

    expect(withoutRequest).toContain('data-composer-container="true"');
    expect(withoutRequest).not.toContain("hidden");
    expect(withRequest).toContain('data-composer-container="true" hidden=""');
  });
});
