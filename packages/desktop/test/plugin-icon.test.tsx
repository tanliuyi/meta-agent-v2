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
const popoverContent = vi.hoisted(() => ({ className: "" }));

vi.mock("electron", () => ({
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) =>
      electron.handlers.set(scheme, handler),
    registerSchemesAsPrivileged: (schemes: unknown[]) => electron.schemes.push(schemes),
  },
}));

// Radix Popover 关闭态在 SSR 下不渲染 Content，无法从 markup 断言层级类；
// 用替身捕获 PopoverContent 收到的 className。
vi.mock("../src/renderer/src/shared/ui/popover-content.tsx", () => ({
  PopoverContent: ({ className }: { className?: string }) => {
    popoverContent.className = className ?? "";
    return <div data-slot="popover-content" />;
  },
}));

const roots: string[] = [];
const pluginIconFixtures = [
  {
    fileName: "icon.svg",
    contentType: "image/svg+xml; charset=utf-8",
    source: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  },
  { fileName: "icon.png", contentType: "image/png", source: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  { fileName: "icon.jpg", contentType: "image/jpeg", source: new Uint8Array([0xff, 0xd8, 0xff]) },
  { fileName: "icon.jpeg", contentType: "image/jpeg", source: new Uint8Array([0xff, 0xd8, 0xff]) },
  { fileName: "icon.webp", contentType: "image/webp", source: new Uint8Array([0x52, 0x49, 0x46, 0x46]) },
  { fileName: "icon.gif", contentType: "image/gif", source: new Uint8Array([0x47, 0x49, 0x46, 0x38]) },
  { fileName: "icon.avif", contentType: "image/avif", source: new Uint8Array([0x66, 0x74, 0x79, 0x70]) },
  { fileName: "icon.bmp", contentType: "image/bmp", source: new Uint8Array([0x42, 0x4d]) },
  { fileName: "icon.ico", contentType: "image/x-icon", source: new Uint8Array([0x00, 0x00, 0x01, 0x00]) },
] as const;

afterEach(async () => {
  electron.handlers.clear();
  electron.schemes.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin icons", () => {
  it("elevates the plugin select popover above the fullscreen session modal", () => {
    renderToStaticMarkup(
      <TooltipProvider>
        <PluginSelect plugins={[]} value={null} onValueChange={() => undefined} />
      </TooltipProvider>,
    );

    // 全屏会话 modal 为 --stack-dialog(60)，插件下拉需用 --stack-menu(80) 覆盖默认 --stack-popover(50)。
    expect(popoverContent.className).toContain("z-(--stack-menu)");
  });

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
    expect(markup).toContain(">L</span>");
  });

  it.each(pluginIconFixtures)(
    "serves the installed $fileName icon through the controlled protocol",
    async (fixture) => {
      const root = join(tmpdir(), `plugin-icon-${crypto.randomUUID()}`);
      roots.push(root);
      const artifactHash = "abc123";
      const iconPath = join(root, ".versions", artifactHash, "payload", "assets", fixture.fileName);
      await mkdir(join(root, ".versions", artifactHash, "payload", "assets"), { recursive: true });
      await writeFile(iconPath, fixture.source);

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
      expect(response.headers.get("content-type")).toBe(fixture.contentType);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture.source);

      const missing = await handler(new Request(marketplacePluginIconUrl("dev.meta-agent.missing")));
      expect(missing.status).toBe(404);
    },
  );
});
