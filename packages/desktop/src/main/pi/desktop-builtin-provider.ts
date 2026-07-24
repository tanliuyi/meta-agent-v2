/**
 * Desktop built-in provider registry.
 *
 * Allows the desktop to register providers without modifying packages/ai.
 * Registration happens at module load via top-level side effects.
 *
 * Data flow:
 *   1. DesktopBuiltinProviderRegistry.register() stores provider configs
 *   2. getExtensionFactories() → InlineExtension[] for ResourceLoader
 *   3. getKnownProviderInfos() → AuthProviderInfo[] for settings UI
 *   4. Extension factories call api.registerProvider() → ModelRegistry
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import type { AuthProviderInfo } from "../../shared/auth-config-contracts.ts";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDefinition,
} from "../../shared/desktop-extension-contracts.ts";
import hermesMemoryExtension from "./extensions/pi-hermes-memory/index.ts";
import subagentsExtension from "./extensions/pi-subagents/index.ts";
import type { SubagentRuntime } from "./extensions/pi-subagents/src/runtime/subagent-runtime.ts";

interface DesktopProviderDefinition {
  displayName: string;
  envKeys: string[];
  extensionFactory: InlineExtension;
}

const providers = new Map<string, DesktopProviderDefinition>();
const builtinExtensions: Array<{ definition: DesktopExtensionDefinition; factory: InlineExtension }> = [
  {
    definition: {
      id: "pi-hermes-memory",
      displayName: "Hermes Memory",
      source: "builtin",
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: [
        "events.subscribe",
        "tools.register",
        "commands.register",
        "messages.enqueue",
        "session.read",
        "session.compact",
        "ui.notify",
        "ui.dialog",
      ],
    },
    factory: { name: "desktop:pi-hermes-memory", factory: hermesMemoryExtension },
  },
  {
    definition: {
      id: "pi-subagents",
      displayName: "Subagents",
      source: "builtin",
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: [
        "events.subscribe",
        "tools.register",
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
    factory: { name: "desktop:pi-subagents", factory: subagentsExtension },
  },
];
const coreProviderIds = new Set(getModelsConfigMetadata().builtInProviders.map((provider) => provider.id));

export const DesktopBuiltinProviderRegistry = {
  /** Register a desktop built-in provider unless the core catalog owns its ID. */
  register(id: string, def: DesktopProviderDefinition): void {
    if (coreProviderIds.has(id) || providers.has(id)) return;
    providers.set(id, def);
  },

  /** Generate inline extension factories for a Desktop thread runtime. */
  getExtensionFactories(options: { subagentRuntime?: SubagentRuntime } = {}): InlineExtension[] {
    return [
      ...[...providers.values()].map((provider) => provider.extensionFactory),
      ...builtinExtensions.map(({ definition, factory }) =>
        definition.id === "pi-subagents" && options.subagentRuntime
          ? {
              name: typeof factory === "function" ? `desktop:${definition.id}` : factory.name,
              factory: (api: ExtensionAPI) => subagentsExtension(api, options.subagentRuntime),
            }
          : factory,
      ),
    ];
  },

  /** Generate the controlled built-ins allowed inside a programmatic subagent worker. */
  getSubagentExtensionFactories(profile: readonly string[]): InlineExtension[] {
    const enabled = new Set(profile);
    return [
      ...(enabled.has("provider") ? [...providers.values()].map((provider) => provider.extensionFactory) : []),
      ...(enabled.has("memory")
        ? [
            {
              name: "desktop:pi-hermes-memory",
              factory: (api: ExtensionAPI) => hermesMemoryExtension(api, { programmaticSubagent: true }),
            },
          ]
        : []),
    ];
  },

  /** Generate stable built-in extension metadata without exposing executable factories across IPC. */
  getExtensionDefinitions(): DesktopExtensionDefinition[] {
    return [
      ...[...providers].map(([id, provider]) => ({
        id: `desktop-provider:${id}`,
        displayName: provider.displayName,
        source: "builtin" as const,
        hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
        capabilities: ["providers.register" as const],
      })),
      ...builtinExtensions.map(({ definition }) => ({
        ...definition,
        capabilities: [...definition.capabilities],
      })),
    ];
  },

  /** Generate known provider info for the auth settings UI. */
  getKnownProviderInfos(): AuthProviderInfo[] {
    return [...providers].map(([id, provider]) => ({
      id,
      displayName: provider.displayName,
      envKeys: provider.envKeys,
    }));
  },
};

// =============================================================================
// Meta Agent Provider
// =============================================================================

const META_AGENT_ID = "meta-agent";
const META_AGENT_DISPLAY_NAME = "Meta Agent Provider";
const META_AGENT_BASE_URL = "http://[fd7a:115c:a1e0::7c3b:e60b]:8080";
const META_AGENT_ENV_KEYS = ["META_AGENT_API_KEY"];

DesktopBuiltinProviderRegistry.register(META_AGENT_ID, {
  displayName: META_AGENT_DISPLAY_NAME,
  envKeys: META_AGENT_ENV_KEYS,
  extensionFactory: {
    name: `desktop:${META_AGENT_ID}`,
    factory: (api) => {
      api.registerProvider(META_AGENT_ID, {
        name: META_AGENT_DISPLAY_NAME,
        api: "openai-responses",
        baseUrl: META_AGENT_BASE_URL,
        // validateProviderConfig requires apiKey or oauth when models are present.
        // The actual key comes from auth.json (Settings UI); this env var reference
        // satisfies validation without requiring the env var itself.
        apiKey: `$${META_AGENT_ENV_KEYS[0]}`,
        authHeader: true,
        models: [
          {
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
            input: ["text"],
            cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 128000,
          },
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
            input: ["text", "image"],
            cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 128000,
            compat: { supportsToolSearch: true },
          },
          {
            id: "gpt-5.4-mini",
            name: "GPT-5.4 mini",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
            input: ["text", "image"],
            cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 128000,
            compat: { supportsToolSearch: true },
          },
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
            input: ["text", "image"],
            cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
            contextWindow: 272000,
            maxTokens: 128000,
            compat: { supportsToolSearch: true },
          },
          {
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
            input: ["text", "image"],
            cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
            contextWindow: 372000,
            maxTokens: 128000,
            compat: { supportsToolSearch: true },
          },
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
            input: ["text", "image"],
            cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
            contextWindow: 372000,
            maxTokens: 128000,
            compat: { supportsToolSearch: true },
          },
          {
            id: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            api: "openai-responses",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
            input: ["text", "image"],
            cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
            contextWindow: 372000,
            maxTokens: 128000,
            compat: { supportsToolSearch: true },
          },
        ],
      });
    },
  },
});
