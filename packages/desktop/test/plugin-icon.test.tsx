import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMarketplacePluginIconRequests } from "../src/main/plugins/marketplace-plugin-icon-protocol.ts";
import { registerLocalImageSchemes } from "../src/main/settings/user-avatar-protocol.ts";
import { PluginSelect } from "../src/renderer/src/components/chat/plugin-select.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import { MARKETPLACE_PLUGIN_ICON_SCHEME, marketplacePluginIconUrl } from "../src/shared/plugin-icon-contracts.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
  schemes: [] as unknown[][],
}));

vi.mock("electron", () => ({
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) =>
      electron.handlers.set(scheme, handler),
    registerSchemesAsPrivileged: (schemes: unknown[]) => electron.schemes.push(schemes),
  },
}));

const roots: string[] = [];

afterEach(async () => {
  electron.handlers.clear();
  electron.schemes.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin icons", () => {
  it("renders an installed marketplace icon in the composer selector", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <PluginSelect
          plugins={[
            { id: "dev.meta-agent.market", displayName: "Market", source: "marketplace", available: true },
            { id: "development:local", displayName: "Local", source: "development", available: true },
          ]}
          value={null}
          onValueChange={() => undefined}
        />
      </TooltipProvider>,
    );

    expect(markup).toContain(`src="${marketplacePluginIconUrl("dev.meta-agent.market")}"`);
    expect(markup).toContain('class="block size-[18px] aspect-square');
    expect(markup).toContain(">L</span>");
  });

  it("serves the immutable installed artifact icon through the controlled protocol", async () => {
    const root = join(tmpdir(), `plugin-icon-${crypto.randomUUID()}`);
    roots.push(root);
    const artifactHash = "abc123";
    const iconPath = join(root, ".versions", artifactHash, "payload", "assets", "icon.svg");
    await mkdir(join(iconPath, ".."), { recursive: true });
    await writeFile(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

    registerLocalImageSchemes();
    handleMarketplacePluginIconRequests({
      getInternalSnapshot: async () => ({
        revision: "revision",
        plugins: [
          {
            id: "dev.meta-agent.market",
            displayName: "Market",
            marketplaceId: "market",
            version: "1.0.0",
            artifactId: "artifact",
            artifactHash,
            enabled: true,
            capabilities: [],
            containsNativeCode: false,
            state: "installed",
            installedAt: 0,
            scope: "global",
            entryPath: join(root, ".versions", artifactHash, "payload", "index.ts"),
            rootPath: root,
          },
        ],
      }),
    });

    expect(electron.schemes[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ scheme: MARKETPLACE_PLUGIN_ICON_SCHEME })]),
    );
    const handler = electron.handlers.get(MARKETPLACE_PLUGIN_ICON_SCHEME);
    if (!handler) throw new Error("Plugin icon protocol handler was not registered");

    const response = await handler(new Request(marketplacePluginIconUrl("dev.meta-agent.market")));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("<svg");

    const missing = await handler(new Request(marketplacePluginIconUrl("dev.meta-agent.missing")));
    expect(missing.status).toBe(404);
  });
});
