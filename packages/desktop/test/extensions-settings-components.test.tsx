import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controller: {
    snapshot: {
      revision: "one",
      developerMode: true,
      reloadRequired: true,
      diagnostics: [],
      entries: [
        {
          id: "builtin",
          displayName: "Built in provider",
          source: "builtin" as const,
          enabled: true,
          configuredEnabled: true,
          capabilities: ["providers.register" as const],
        },
        {
          id: "curated:one",
          displayName: "Curated extension",
          source: "curated" as const,
          enabled: true,
          configuredEnabled: true,
          capabilities: [],
        },
        {
          id: "development:one",
          displayName: "local.ts",
          source: "development" as const,
          enabled: true,
          configuredEnabled: true,
          capabilities: [],
          displayPath: "local.ts",
        },
      ],
    },
    loading: false,
    mutating: false,
    error: null,
    applyResult: { status: "rolled-back" as const, generation: "previous", error: "load failed" },
    reload: vi.fn(),
    mutate: vi.fn(),
    chooseDevelopmentEntry: vi.fn(),
    apply: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ returnProjectId: "project", returnThreadId: "thread" }),
}));
vi.mock("../src/renderer/src/features/settings/use-extensions-settings-controller.ts", () => ({
  useExtensionsSettingsController: () => mocks.controller,
}));

import { ExtensionsSettingsPage } from "../src/renderer/src/features/settings/extensions-settings-page.tsx";

describe("ExtensionsSettingsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes controlled sources and discloses Developer Mode authority", () => {
    const markup = renderToStaticMarkup(<ExtensionsSettingsPage />);

    expect(markup).toContain("Built-in");
    expect(markup).toContain("Curated");
    expect(markup).toContain("Development");
    expect(markup).toContain("普通 Node 代码");
    expect(markup).toContain("draft metadata worker");
    expect(markup).toContain("Pi TUI");
    expect(markup).toContain("应用到当前会话");
    expect(markup).toContain("移除批准记录");
    expect(markup).toContain("已恢复上一配置");
    expect(markup).not.toContain("扩展配置已应用");
    expect(markup).not.toContain("packages center");
  });
});
