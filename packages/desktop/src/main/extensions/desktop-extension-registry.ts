import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDefinition,
} from "../../shared/desktop-extension-contracts.ts";
import { pluginCallCatalog as piBrowserCatalog } from "../pi/extensions/pi-browser/index.ts";
import { pluginCallCatalog as piHermesCatalog } from "../pi/extensions/pi-hermes-memory/index.ts";
import { pluginCallCatalog as piSubagentsCatalog } from "../pi/extensions/pi-subagents/index.ts";
import { getBuiltinSkillPath } from "./desktop-builtin-resource-paths.ts";

const builtinExtensions: DesktopExtensionDefinition[] = [
  {
    id: "desktop-provider:meta-agent",
    displayName: "Meta Agent Provider",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    capabilities: ["providers.register"],
  },
  {
    id: "pi-hermes-memory",
    displayName: "Hermes Memory",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    skillPaths: [getBuiltinSkillPath(import.meta.url, "pi-hermes-memory")],
    pluginCallSkill: "pi-hermes-memory",
    pluginCallCatalog: piHermesCatalog,
    capabilities: [
      "plugin-methods.provide",
      "events.subscribe",
      "commands.register",
      "messages.enqueue",
      "session.read",
      "session.compact",
      "ui.notify",
      "ui.dialog",
    ],
  },
  {
    id: "pi-rewind",
    displayName: "Checkpoint History",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    capabilities: ["events.subscribe", "messages.custom", "session.read", "ui.notify"],
  },
  {
    id: "pi-subagents",
    displayName: "Subagents",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    skillPaths: [getBuiltinSkillPath(import.meta.url, "pi-subagents")],
    pluginCallSkill: "pi-subagents",
    pluginCallCatalog: piSubagentsCatalog,
    capabilities: [
      "plugin-methods.provide",
      "events.subscribe",
      "commands.register",
      "messages.enqueue",
      "messages.custom",
      "session.read",
      "session.abort",
      "session.compact",
      "session.reload",
      "ui.notify",
      "ui.dialog",
      "ui.status",
    ],
  },
  {
    id: "pi-auto-title",
    displayName: "自动标题",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    capabilities: ["events.subscribe", "session.read"],
  },
  {
    id: "pi-browser",
    displayName: "内置浏览器",
    source: "builtin",
    hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
    skillPaths: [getBuiltinSkillPath(import.meta.url, "pi-browser")],
    pluginCallSkill: "pi-browser",
    pluginCallCatalog: piBrowserCatalog,
    capabilities: ["plugin-methods.provide", "events.subscribe", "session.read", "ui.notify"],
  },
];
const curatedExtensions: DesktopExtensionDefinition[] = [];

/** Static release-locked metadata. Executable inline factories remain sidecar-only. */
export const DesktopControlledExtensionRegistry = {
  getBuiltinDefinitions(): DesktopExtensionDefinition[] {
    return builtinExtensions.map((definition) => ({
      ...definition,
      capabilities: [...definition.capabilities],
      ...(definition.skillPaths ? { skillPaths: [...definition.skillPaths] } : {}),
    }));
  },

  getCuratedDefinitions(): DesktopExtensionDefinition[] {
    return curatedExtensions.map((definition) => ({ ...definition, capabilities: [...definition.capabilities] }));
  },
};
