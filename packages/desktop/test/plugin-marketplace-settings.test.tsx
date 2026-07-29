import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarketplaceEndpointSettings } from "../src/renderer/src/features/plugins/marketplace-endpoint-settings.tsx";

vi.mock("../src/renderer/src/features/plugins/use-marketplace-endpoint-settings.ts", () => ({
  useMarketplaceEndpointSettings: () => ({
    snapshot: { revision: "one", endpoints: [] },
    loading: false,
    pending: false,
    testResult: {
      status: "ready",
      endpoint: {
        marketplaceId: "example.market",
        baseUrl: "https://market.example/",
        apiRoot: "https://market.example/v1/",
        active: true,
      },
    },
    reload: vi.fn(),
    resetTest: vi.fn(),
    test: vi.fn(),
    save: vi.fn(),
  }),
}));

describe("marketplace endpoint settings", () => {
  it("renders endpoint URL testing and resolved API metadata", () => {
    const markup = renderToStaticMarkup(<MarketplaceEndpointSettings />);
    expect(markup).toContain("Marketplace API URL");
    expect(markup).toContain('type="url"');
    expect(markup).toContain("测试连接");
    expect(markup).toContain("https://market.example/v1/");
  });
});
