import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunner } from "./cli.ts";
import { resolveConfig } from "./config.ts";
import { registerInspectTools } from "./tools/inspect.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerWriteTools } from "./tools/write.ts";

export type DesktopExtensionAPI = ExtensionAPI & {
  getConfig<T = Readonly<Record<string, string | number | boolean>>>(): Readonly<T>;
};

export function activateOfficePlugin(pi: ExtensionAPI): void {
  const desktopApi = pi as DesktopExtensionAPI;
  const runner = createRunner(resolveConfig(desktopApi.getConfig()));
  registerReadTools(pi, runner);
  registerWriteTools(pi, runner);
  registerInspectTools(pi, runner);
}
