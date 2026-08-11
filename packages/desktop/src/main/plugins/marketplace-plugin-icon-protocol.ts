import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { protocol } from "electron";
import { MARKETPLACE_PLUGIN_ICON_SCHEME } from "../../shared/plugin-icon-contracts.ts";
import type { InstalledMarketplacePluginRecord, MarketplacePluginRegistry } from "./marketplace-plugin-registry.ts";

const MAX_PLUGIN_ICON_BYTES = 1024 * 1024;
const PLUGIN_ICON_ASSETS = [
  { fileName: "icon.svg", contentType: "image/svg+xml; charset=utf-8" },
  { fileName: "icon.png", contentType: "image/png" },
  { fileName: "icon.jpg", contentType: "image/jpeg" },
  { fileName: "icon.jpeg", contentType: "image/jpeg" },
  { fileName: "icon.webp", contentType: "image/webp" },
  { fileName: "icon.gif", contentType: "image/gif" },
  { fileName: "icon.avif", contentType: "image/avif" },
  { fileName: "icon.bmp", contentType: "image/bmp" },
  { fileName: "icon.ico", contentType: "image/x-icon" },
] as const;

export function handleMarketplacePluginIconRequests(
  registry: Pick<MarketplacePluginRegistry, "getInternalSnapshot">,
): void {
  protocol.handle(MARKETPLACE_PLUGIN_ICON_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pluginId = url.hostname === "installed" && url.pathname === "/icon" ? url.searchParams.get("pluginId") : null;
    if (!pluginId) return notFound();

    try {
      const { plugins } = await registry.getInternalSnapshot();
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      return plugin ? serveInstalledPluginIcon(plugin) : notFound();
    } catch {
      return notFound();
    }
  });
}

async function serveInstalledPluginIcon(plugin: InstalledMarketplacePluginRecord): Promise<Response> {
  const iconRoot = join(plugin.rootPath, ".versions", plugin.artifactHash, "payload", "assets");
  for (const asset of PLUGIN_ICON_ASSETS) {
    const iconPath = join(iconRoot, asset.fileName);
    try {
      const info = await lstat(iconPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PLUGIN_ICON_BYTES) continue;
      const icon = await readFile(iconPath);
      return new Response(icon, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Content-Type": asset.contentType,
        },
      });
    } catch {
      // Try the next supported icon format.
    }
  }
  return notFound();
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
