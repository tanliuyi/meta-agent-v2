import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateWebAccessPlugin } from "./src/plugin-call.ts";
import { applyDesktopConfig, type DesktopWebAccessConfig } from "./src/configuration.ts";

interface DesktopExtensionAPI extends ExtensionAPI {
  getConfig<T = Readonly<Record<string, string | number | boolean>>>(): Readonly<T>;
}

export default function piWebAccessDesktop(pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => ({
    skillPaths: [fileURLToPath(new URL("./skills/pi-web-access/SKILL.md", import.meta.url))],
  }));
  const desktopApi = pi as DesktopExtensionAPI;
  applyDesktopConfig(desktopApi.getConfig<DesktopWebAccessConfig>());
  activateWebAccessPlugin(pi);
}
