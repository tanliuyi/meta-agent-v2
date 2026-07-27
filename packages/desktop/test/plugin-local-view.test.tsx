import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocalPluginsView } from "../src/renderer/src/features/plugins/local-plugins-view.tsx";
import type { LocalPluginsController } from "../src/renderer/src/features/plugins/use-local-plugins.ts";

function controller(): LocalPluginsController {
  return {
    snapshot: {
      revision: "revision-1",
      developerMode: true,
      reloadRequired: true,
      desiredGeneration: "generation-2",
      diagnostics: [
        {
          extensionId: "development:example",
          source: "development",
          phase: "load",
          code: "load-failed",
          message: "插件加载失败",
        },
      ],
      entries: [
        {
          id: "development:example",
          displayName: "example-plugin.ts",
          displayPath: "example-plugin.ts",
          source: "development",
          enabled: true,
          configuredEnabled: true,
          capabilities: [],
        },
      ],
    },
    loading: false,
    mutating: false,
    clearError: vi.fn(),
    reload: vi.fn(async () => undefined),
    mutate: vi.fn(async () => undefined),
    chooseDevelopmentEntry: vi.fn(async () => undefined),
  };
}

describe("local plugins view", () => {
  it("renders approved development plugins and local management actions", () => {
    const markup = renderToStaticMarkup(<LocalPluginsView controller={controller()} />);

    expect(markup).toContain("本地插件");
    expect(markup).toContain("Developer Mode");
    expect(markup).toContain("example-plugin.ts");
    expect(markup).toContain("Development");
    expect(markup).toContain("添加本地插件");
    expect(markup).toContain("/reload");
    expect(markup).not.toContain("应用到当前会话");
    expect(markup).toContain("development:example: 插件加载失败");
    expect(markup).toContain('aria-label="移除 example-plugin.ts"');
  });
});
