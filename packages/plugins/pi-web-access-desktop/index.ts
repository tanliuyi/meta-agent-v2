import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWebAccess from "pi-web-access/index.ts";
import { applyDesktopConfig, type DesktopWebAccessConfig } from "./src/configuration.ts";
import { createDesktopApi } from "./desktop-api.ts";

export default function piWebAccessDesktop(pi: ExtensionAPI): void {
  applyDesktopConfig(pi.getConfig<DesktopWebAccessConfig>());
  piWebAccess(createDesktopApi(pi));
}
