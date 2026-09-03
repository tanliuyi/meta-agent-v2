import { fileURLToPath } from "node:url";
import { createAcpExtension as createSourceAcpExtension } from "./src/index.ts";
import type { AdapterConfig } from "./src/config.ts";

const extensionEntryPath = fileURLToPath(import.meta.url);

export function createAcpExtension(adapter: AdapterConfig = {}) {
  return createSourceAcpExtension({
    ...adapter,
    autoUpdate: adapter.autoUpdate ?? false,
    childExtensionPath: adapter.childExtensionPath ?? extensionEntryPath,
  });
}

export { desktopPlugin, pluginCallCatalog } from "./src/index.ts";

export default createAcpExtension();
