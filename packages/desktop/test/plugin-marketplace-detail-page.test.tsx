import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginMarketplaceDetailPage } from "../src/renderer/src/features/plugins/plugin-marketplace-detail-page.tsx";
import {
  loadMarketplacePluginDetail,
  needsPluginDetailLookup,
  type PluginMarketplaceController,
  resolveMarketplaceDetailPlugin,
} from "../src/renderer/src/features/plugins/use-plugin-marketplace.ts";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import type { MarketplacePluginPage, MarketplacePluginSummary } from "../src/shared/plugin-marketplace-contracts.ts";

const plugin: MarketplacePluginSummary = {
  id: "plugin.deep",
  name: "Deep Plugin",
  description: "Plugin beyond the first catalog page.",
  publisher: { id: "meta-agent", displayName: "Meta Agent", verified: true },
  categories: ["Developer Tools"],
  latestVersion: "1.0.0",
  compatibleVersion: "1.0.0",
  containsNativeCode: false,
  status: "available",
  publishedAt: 1,
  updatedAt: 2,
};

const { controller } = vi.hoisted(() => {
  const controller: PluginMarketplaceController = {
    page: undefined,
    installed: undefined,
    query: "",
    loading: true,
    installingId: undefined,
    updatingId: undefined,
    uninstallingId: undefined,
    settingEnabledId: undefined,
    settingScopeId: undefined,
    error: undefined,
    notice: undefined,
    clearError: vi.fn(),
    clearNotice: vi.fn(),
    setQuery: vi.fn(),
    refresh: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    setScope: vi.fn(async () => undefined),
  };
  return { controller };
});

vi.mock("../src/renderer/src/features/plugins/use-plugin-marketplace.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/renderer/src/features/plugins/use-plugin-marketplace.ts")>();
  return {
    ...actual,
    usePluginMarketplace: () => controller,
  };
});

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopSelector: () => [],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../src/renderer/src/features/plugins/plugin-detail-actions.tsx", () => ({
  PluginDetailActions: () => <div data-slot="detail-actions" />,
}));
vi.mock("../src/renderer/src/features/plugins/plugin-detail-content.tsx", () => ({
  PluginDetailContent: () => <div data-slot="detail-content" />,
}));
vi.mock("../src/renderer/src/features/plugins/plugin-detail-back-link.tsx", () => ({
  PluginDetailBackLink: () => <div data-slot="detail-back-link" />,
}));
vi.mock("../src/renderer/src/features/plugins/plugin-detail-status.tsx", () => ({
  PluginDetailStatusBadges: () => <span data-slot="detail-status" />,
}));
vi.mock("../src/renderer/src/features/plugins/plugin-marketplace-breadcrumb.tsx", () => ({
  PluginMarketplaceBreadcrumb: () => <span data-slot="breadcrumb" />,
}));
vi.mock("../src/renderer/src/features/plugins/marketplace-settings-dialog.tsx", () => ({
  MarketplaceSettingsDialog: () => null,
}));
vi.mock("../src/renderer/src/components/layout/sidebar-toggle.tsx", () => ({
  SidebarToggle: () => null,
}));

beforeEach(() => {
  controller.page = undefined;
  controller.installed = undefined;
  controller.loading = true;
  controller.error = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDetail(pluginId: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <PluginMarketplaceDetailPage pluginId={pluginId} />
    </TooltipProvider>,
  );
}

describe("PluginMarketplaceDetailPage direct plugin lookup", () => {
  it("needsPluginDetailLookup requires a direct query when the list page has no match", () => {
    const page: MarketplacePluginPage = {
      marketplaceId: "example.market",
      plugins: [plugin],
      source: "network",
      stale: false,
      fetchedAt: 1,
    };
    expect(needsPluginDetailLookup(undefined, "plugin.deep")).toBe(true);
    expect(needsPluginDetailLookup(page, "plugin.deep")).toBe(false);
    expect(needsPluginDetailLookup(page, "plugin.other")).toBe(true);
  });

  it("resolveMarketplaceDetailPlugin prefers the list page and only accepts a lookup for the active id", () => {
    const page: MarketplacePluginPage = {
      marketplaceId: "example.market",
      plugins: [plugin],
      source: "network",
      stale: false,
      fetchedAt: 1,
    };
    const lookup = { pluginId: "plugin.deep", status: "found" as const, plugin };
    expect(resolveMarketplaceDetailPlugin(page, "plugin.deep", undefined)).toEqual(plugin);
    expect(resolveMarketplaceDetailPlugin(undefined, "plugin.deep", lookup)).toEqual(plugin);
    expect(resolveMarketplaceDetailPlugin(undefined, "plugin.other", lookup)).toBeUndefined();
  });

  it("loads an exact plugin id and represents missing and error results", async () => {
    const getPlugin = vi
      .fn()
      .mockResolvedValueOnce(plugin)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("catalog offline"));

    await expect(loadMarketplacePluginDetail("plugin.deep", getPlugin)).resolves.toEqual({
      pluginId: "plugin.deep",
      status: "found",
      plugin,
    });
    await expect(loadMarketplacePluginDetail("plugin.missing", getPlugin)).resolves.toEqual({
      pluginId: "plugin.missing",
      status: "missing",
    });
    await expect(loadMarketplacePluginDetail("plugin.error", getPlugin)).resolves.toEqual({
      pluginId: "plugin.error",
      status: "error",
      error: "catalog offline",
    });
    expect(getPlugin.mock.calls.map(([pluginId]) => pluginId)).toEqual([
      "plugin.deep",
      "plugin.missing",
      "plugin.error",
    ]);
  });

  it("renders the detail from the list page when the id is already present", () => {
    controller.page = {
      marketplaceId: "example.market",
      plugins: [plugin],
      source: "network",
      stale: false,
      fetchedAt: 1,
    };
    controller.loading = false;
    vi.stubGlobal("window", {
      desktop: {
        marketplace: { getPlugin: vi.fn() },
      },
    });
    const markup = renderDetail("plugin.deep");

    expect(markup).toContain("Deep Plugin");
    expect(markup).toContain("Plugin beyond the first catalog page.");
  });

  it("keeps the direct lookup pending state visible when the list page has no match", () => {
    controller.page = { marketplaceId: "example.market", plugins: [], source: "network", stale: false, fetchedAt: 1 };
    controller.loading = true;
    vi.stubGlobal("window", {
      desktop: {
        marketplace: { getPlugin: vi.fn(async () => plugin) },
      },
    });
    const markup = renderDetail("plugin.deep");

    expect(markup).toContain("正在载入插件详情");
  });

  it("falls back to the direct lookup state while the list page is still loading", () => {
    controller.page = undefined;
    controller.loading = true;
    vi.stubGlobal("window", {
      desktop: {
        marketplace: { getPlugin: vi.fn(async () => plugin) },
      },
    });
    const markup = renderDetail("plugin.deep");

    expect(markup).toContain("正在载入插件详情");
  });
});
