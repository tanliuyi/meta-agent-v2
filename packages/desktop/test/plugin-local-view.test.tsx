import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPluginDetailContent } from "../src/renderer/src/features/plugins/local-plugin-detail-content.tsx";
import { LocalPluginsView } from "../src/renderer/src/features/plugins/local-plugins-view.tsx";
import type { LocalPluginsController } from "../src/renderer/src/features/plugins/use-local-plugins.ts";
import type { DesktopExtensionListEntry } from "../src/shared/desktop-extension-contracts.ts";

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopSelector: () => [],
}));

beforeEach(() => {
  vi.clearAllMocks();
});

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
          scope: "global",
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

function entry(): DesktopExtensionListEntry {
  return {
    id: "development:example",
    displayName: "example-plugin.ts",
    displayPath: "example-plugin.ts",
    source: "development",
    enabled: true,
    configuredEnabled: true,
    capabilities: [],
    scope: "global",
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
    expect(markup).toContain("插件加载失败");
    expect(markup).toContain('aria-label="查看 example-plugin.ts 详情"');
    expect(markup).toContain('aria-label="移除 example-plugin.ts"');
  });
});

describe("local plugin detail dialog", () => {
  it("renders entry metadata, trust warning, diagnostics, and detail tabs", () => {
    const markup = renderToStaticMarkup(
      <LocalPluginDetailContent
        plugin={entry()}
        diagnostics={[
          {
            extensionId: "development:example",
            source: "development",
            phase: "load",
            code: "load-failed",
            message: "插件加载失败",
          },
        ]}
        mutating={false}
        onToggleEnabled={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain("example-plugin.ts");
    expect(markup).toContain("本地开发");
    expect(markup).toContain("development:example");
    expect(markup).toContain("入口路径");
    expect(markup).toContain("Developer Mode 本地插件");
    expect(markup).toContain("以当前账户权限运行");
    expect(markup).toContain("未提供能力声明");
    expect(markup).toContain("插件加载失败");
    expect(markup).toContain('aria-label="插件详情"');
    expect(markup).toContain(">基本信息</button>");
    expect(markup).toContain(">配置</button>");
    expect(markup).not.toContain("本地插件没有声明配置 Schema");
    expect(markup).toContain("启用此插件");
    expect(markup).toContain(">移除</button>");
  });

  it("keeps the configuration panel lazy until its tab is selected", () => {
    const configurable: DesktopExtensionListEntry = {
      ...entry(),
      capabilities: ["configuration.read", "tools.register"],
      configurationSchema: {
        version: 1,
        fields: [
          { key: "endpoint", label: "Endpoint", type: "text", required: true },
          { key: "token", label: "Token", type: "secret" },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      <LocalPluginDetailContent
        plugin={configurable}
        diagnostics={[]}
        mutating={false}
        onToggleEnabled={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="插件详情"');
    expect(markup).toContain(">基本信息</button>");
    expect(markup).toContain(">配置</button>");
    expect(markup).toContain('data-state="inactive"');
    expect(markup).not.toContain('id="plugin-detail-configuration"');
    expect(markup).not.toContain("正在载入配置");
  });

  it("hides the diagnostics section when there are none", () => {
    const markup = renderToStaticMarkup(
      <LocalPluginDetailContent
        plugin={entry()}
        diagnostics={[]}
        mutating={false}
        onToggleEnabled={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).not.toContain("诊断");
  });

  it("does not render project scope settings", () => {
    const scoped: DesktopExtensionListEntry = {
      ...entry(),
      scope: "project",
      projectIds: ["project-a"],
    };
    const markup = renderToStaticMarkup(
      <LocalPluginDetailContent
        plugin={scoped}
        diagnostics={[]}
        mutating={false}
        onToggleEnabled={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).not.toContain("作用域");
    expect(markup).not.toContain("指定项目");
  });
});
