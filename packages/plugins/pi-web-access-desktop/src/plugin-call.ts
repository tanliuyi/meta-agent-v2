import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWebAccess from "../vendor/pi-web-access/index.ts";
import { createDesktopApi } from "../desktop-api.ts";

const PLUGIN_CALL_CONFIG = {
  webSearch: { enabled: true },
  toolNames: {
    webSearch: "web_search",
    sourceCheck: "source_check",
    fetchContent: "fetch_content",
    getSearchContent: "get_search_content",
  },
};

export function activateWebAccessPlugin(pi: ExtensionAPI): void {
  piWebAccess(createDesktopApi(pi), PLUGIN_CALL_CONFIG);
}
