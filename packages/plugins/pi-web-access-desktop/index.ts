import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWebAccess from "./vendor/pi-web-access/index.ts";
import {
  applyDesktopConfig,
  type DesktopWebAccessConfig,
  getRunCodeToolNameAliases,
} from "./src/configuration.ts";
import { createDesktopApi } from "./desktop-api.ts";

export default function piWebAccessDesktop(pi: ExtensionAPI): void {
  applyDesktopConfig(pi.getConfig<DesktopWebAccessConfig>());
  piWebAccess(createDesktopApi(pi, { toolNameAliases: getRunCodeToolNameAliases() }));
}
