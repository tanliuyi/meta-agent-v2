import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDefinition,
} from "../../shared/desktop-extension-contracts.ts";

const builtinExtensions: DesktopExtensionDefinition[] = [
  {
    id: "desktop-provider:meta-agent",
    displayName: "Meta Agent Provider",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    capabilities: ["providers.register"],
  },
];
const curatedExtensions: DesktopExtensionDefinition[] = [];

/** Static release-locked metadata. Executable inline factories remain sidecar-only. */
export const DesktopControlledExtensionRegistry = {
  getBuiltinDefinitions(): DesktopExtensionDefinition[] {
    return builtinExtensions.map((definition) => ({ ...definition, capabilities: [...definition.capabilities] }));
  },

  getCuratedDefinitions(): DesktopExtensionDefinition[] {
    return curatedExtensions.map((definition) => ({ ...definition, capabilities: [...definition.capabilities] }));
  },
};
