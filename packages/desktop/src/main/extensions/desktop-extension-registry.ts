import type { DesktopExtensionDefinition } from "../../shared/desktop-extension-contracts.ts";
import { DesktopBuiltinProviderRegistry } from "../pi/desktop-builtin-provider.ts";

const curatedExtensions: DesktopExtensionDefinition[] = [];

/** Static release-locked metadata. Executable inline factories remain sidecar-only. */
export const DesktopControlledExtensionRegistry = {
  getBuiltinDefinitions(): DesktopExtensionDefinition[] {
    return DesktopBuiltinProviderRegistry.getExtensionDefinitions();
  },

  getCuratedDefinitions(): DesktopExtensionDefinition[] {
    return curatedExtensions.map((definition) => ({ ...definition, capabilities: [...definition.capabilities] }));
  },
};
