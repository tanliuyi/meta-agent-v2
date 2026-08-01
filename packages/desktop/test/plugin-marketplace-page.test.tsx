import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PluginConfigurationForm } from "../src/renderer/src/features/plugins/plugin-configuration-form.tsx";
import { pluginActionConfirmation } from "../src/renderer/src/features/plugins/plugin-detail-dialog.tsx";
import { MarketplacePluginCard } from "../src/renderer/src/features/plugins/plugin-marketplace-card.tsx";
import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../src/shared/plugin-marketplace-contracts.ts";

const plugin: MarketplacePluginSummary = {
  id: "example.tools",
  name: "Example Tools",
  description: "Reference Pi extension published through the marketplace.",
  publisher: {
    id: "meta-agent",
    displayName: "Meta Agent",
    verified: true,
  },
  categories: ["Developer Tools"],
  latestVersion: "1.1.0",
  compatibleVersion: "1.1.0",
  containsNativeCode: true,
  capabilities: ["tools.register"],
  status: "available",
  publishedAt: 1,
  updatedAt: 2,
};

vi.mock("../src/renderer/src/features/plugins/use-plugin-marketplace.ts", () => ({
  canInstallMarketplacePlugin: () => true,
  usePluginMarketplace: () => ({
    page: {
      marketplaceId: "example.market",
      plugins: [],
      source: "network",
      stale: false,
      fetchedAt: 1,
    },
    installed: { revision: "installed-one", plugins: [] },
    query: "",
    loading: false,
    clearError: vi.fn(),
    clearNotice: vi.fn(),
    setQuery: vi.fn(),
    refresh: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
  }),
}));

vi.mock("../src/renderer/src/features/plugins/use-local-plugins.ts", () => ({
  useLocalPlugins: () => ({
    snapshot: {
      revision: "extensions-one",
      developerMode: false,
      reloadRequired: false,
      desiredGeneration: "generation-one",
      diagnostics: [],
      entries: [],
    },
    loading: false,
    mutating: false,
    clearError: vi.fn(),
    reload: vi.fn(async () => undefined),
    mutate: vi.fn(async () => undefined),
    chooseDevelopmentEntry: vi.fn(async () => undefined),
  }),
}));

const installed: InstalledMarketplacePluginSummary = {
  id: plugin.id,
  displayName: plugin.name,
  marketplaceId: "example.market",
  version: "1.0.0",
  artifactId: "example-tools-1.0.0",
  enabled: true,
  capabilities: ["tools.register"],
  containsNativeCode: true,
  configurable: true,
  state: "installed",
  installedAt: 1,
};

describe("plugin detail confirmation", () => {
  it("mounts the host-rendered configuration section for configurable installed plugins", () => {
    const markup = renderToStaticMarkup(<PluginConfigurationForm pluginId={installed.id} />);

    expect(markup).toContain('id="plugin-detail-configuration"');
    expect(markup).toContain("正在载入配置");
  });

  it("keeps install and uninstall warnings in the detail dialog confirmation state", () => {
    expect(pluginActionConfirmation("install", plugin.name, plugin)).toEqual({
      title: "安装 Example Tools？",
      description:
        "市场插件是全信任 Pi Extension，可读写本机文件、访问网络并执行进程，不受能力声明限制。该版本包含原生模块或平台二进制。声明能力：tools.register。",
      confirmLabel: "确认安装",
    });
    expect(pluginActionConfirmation("uninstall", plugin.name, plugin)).toEqual({
      title: "卸载 Example Tools？",
      description:
        "插件将不再用于新会话。当前运行中的会话会继续使用原版本，直到运行 /reload；本地版本会暂时保留，以保护仍在运行或已修改的文件。",
      confirmLabel: "确认卸载",
    });
  });
});

describe("plugin marketplace cards", () => {
  it("renders a keyboard-accessible catalog card with compact plugin metadata", () => {
    const markup = renderToStaticMarkup(<MarketplacePluginCard plugin={plugin} onOpen={vi.fn()} />);

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="查看 Example Tools 详情"');
    expect(markup).toContain("Meta Agent");
    expect(markup).toContain("v1.1.0");
    expect(markup).toContain("Developer Tools");
    expect(markup).toContain("Native");
  });

  it("shows update and local-only states without placing action buttons inside the card", () => {
    const updateMarkup = renderToStaticMarkup(
      <MarketplacePluginCard plugin={plugin} installed={installed} onOpen={vi.fn()} />,
    );
    const localMarkup = renderToStaticMarkup(<MarketplacePluginCard installed={installed} onOpen={vi.fn()} />);

    expect(updateMarkup).toContain("可更新");
    expect(updateMarkup.match(/<button/g)).toHaveLength(1);
    expect(localMarkup).toContain("当前市场目录中没有对应条目");
    expect(localMarkup).toContain("已安装");
  });
});
