import { describe, expect, it } from "vitest";
import { marketplaceEndpointErrorMessage } from "../src/renderer/src/features/plugins/use-marketplace-endpoint-settings.ts";
import {
  canInstallMarketplacePlugin,
  marketplaceErrorMessage,
  resolvePluginMarketplaceLoad,
} from "../src/renderer/src/features/plugins/use-plugin-marketplace.ts";

describe("plugin marketplace renderer loading", () => {
  const installed = { revision: "installed-one", plugins: [] };

  it("keeps deprecated versions installable while refusing withdrawn and blocked versions", () => {
    const plugin = {
      id: "plugin.one",
      name: "Plugin",
      description: "Plugin",
      publisher: { id: "publisher", displayName: "Publisher", verified: true },
      categories: [],
      compatibleVersion: "1.0.0",
      containsNativeCode: false,
      publishedAt: 1,
      updatedAt: 1,
    };
    expect(canInstallMarketplacePlugin({ ...plugin, status: "deprecated" })).toBe(true);
    expect(canInstallMarketplacePlugin({ ...plugin, status: "withdrawn" })).toBe(false);
    expect(canInstallMarketplacePlugin({ ...plugin, status: "blocked" })).toBe(false);
  });

  it("keeps the local installed snapshot available when the remote catalog is offline", () => {
    expect(
      resolvePluginMarketplaceLoad(
        { status: "rejected", reason: new Error("catalog offline") },
        { status: "fulfilled", value: installed },
        true,
      ),
    ).toEqual({ installed, error: "catalog offline" });
  });

  it("does not let an older load overwrite a snapshot committed by a mutation", () => {
    expect(
      resolvePluginMarketplaceLoad(
        {
          status: "fulfilled",
          value: {
            marketplaceId: "market",
            plugins: [],
            source: "network",
            stale: false,
            fetchedAt: 1,
          },
        },
        { status: "fulfilled", value: installed },
        false,
      ),
    ).not.toHaveProperty("installed");
  });
});

describe("plugin marketplace renderer errors", () => {
  it("maps an unconfigured endpoint to concise product copy", () => {
    expect(
      marketplaceErrorMessage(
        new Error(
          "Error invoking remote method 'desktop:marketplace:list-plugins': Error: Marketplace API URL is not configured",
        ),
      ),
    ).toBe("尚未配置插件市场 API。");
  });

  it("explains that a 404 URL is not a marketplace service root", () => {
    expect(marketplaceEndpointErrorMessage("Marketplace request failed with HTTP 404")).toBe(
      "该地址不是有效的插件市场 API。请填写市场服务根地址，而不是应用界面地址。",
    );
  });

  it("removes Electron remote method wrapping from other errors", () => {
    expect(
      marketplaceErrorMessage(
        new Error("Error invoking remote method 'desktop:marketplace:list-plugins': Error: Marketplace unavailable"),
      ),
    ).toBe("Marketplace unavailable");
  });
});
