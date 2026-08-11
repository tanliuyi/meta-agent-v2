export const MARKETPLACE_PLUGIN_ICON_SCHEME = "meta-agent-plugin-icon";

export function marketplacePluginIconUrl(pluginId: string): string {
  return `${MARKETPLACE_PLUGIN_ICON_SCHEME}://installed/icon?pluginId=${encodeURIComponent(pluginId)}`;
}
