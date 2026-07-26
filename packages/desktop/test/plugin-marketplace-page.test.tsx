import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarketplacePluginCard } from "../src/renderer/src/features/plugins/plugin-marketplace-page.tsx";
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

const installed: InstalledMarketplacePluginSummary = {
  id: plugin.id,
  displayName: plugin.name,
  marketplaceId: "example.market",
  version: "1.0.0",
  artifactId: "example-tools-1.0.0",
  enabled: true,
  capabilities: ["tools.register"],
  containsNativeCode: true,
  state: "installed",
  installedAt: 1,
};

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
