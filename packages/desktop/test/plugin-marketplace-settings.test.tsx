import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarketplaceEndpointSettings } from "../src/renderer/src/features/settings/marketplace-endpoint-settings.tsx";

vi.mock("../src/renderer/src/features/settings/use-marketplace-endpoint-settings.ts", () => ({
  useMarketplaceEndpointSettings: () => ({
    snapshot: { revision: "one", endpoints: [] },
    loading: false,
    pending: false,
    testResult: {
      status: "ready",
      confirmationRequired: true,
      confirmationToken: "confirm",
      endpoint: {
        marketplaceId: "example.market",
        baseUrl: "https://market.example/",
        apiRoot: "https://market.example/v1/",
        artifactOrigins: ["https://artifacts.example"],
        signing: {
          algorithm: "ed25519",
          keyId: "key",
          fingerprint: "sha256:1234",
        },
        active: true,
      },
    },
    reload: vi.fn(),
    test: vi.fn(),
    save: vi.fn(),
  }),
}));

describe("marketplace endpoint settings", () => {
  it("renders URL testing and explicit signing fingerprint trust", () => {
    const markup = renderToStaticMarkup(<MarketplaceEndpointSettings />);
    expect(markup).toContain("Marketplace API URL");
    expect(markup).toContain('type="url"');
    expect(markup).toContain("测试连接");
    expect(markup).toContain("sha256:1234");
    expect(markup).toContain("信任此市场签名密钥");
  });
});
