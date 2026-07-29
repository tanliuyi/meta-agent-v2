import {
  BUILT_IN_MODELS,
  DEFAULT_API_STYLE,
  DEFAULT_BASE_URL,
  ENV_VARS,
  PROVIDER_DISPLAY_NAME,
} from "./models.ts";
import type {
  BuiltInProviderId,
  DesktopImageGenConfig,
  ImageGenSettings,
  ResolvedModel,
  ResolvedProvider,
} from "./types.ts";

const PROVIDER_IDS = ["openai", "gemini", "dashscope", "openrouter", "ark"] as const;

const CONFIG_KEYS: Record<
  BuiltInProviderId,
  { apiKey: keyof DesktopImageGenConfig; baseUrl: keyof DesktopImageGenConfig }
> = {
  openai: { apiKey: "openaiApiKey", baseUrl: "openaiBaseUrl" },
  gemini: { apiKey: "geminiApiKey", baseUrl: "geminiBaseUrl" },
  dashscope: { apiKey: "dashscopeApiKey", baseUrl: "dashscopeBaseUrl" },
  ark: { apiKey: "arkApiKey", baseUrl: "arkBaseUrl" },
  openrouter: { apiKey: "openrouterApiKey", baseUrl: "openrouterBaseUrl" },
};

export function createImageGenSettings(config: Readonly<DesktopImageGenConfig>): ImageGenSettings {
  const providers: ImageGenSettings["providers"] = {};
  for (const id of PROVIDER_IDS) {
    const keys = CONFIG_KEYS[id];
    const configuredKey = config[keys.apiKey];
    const configuredBaseUrl = config[keys.baseUrl];
    const override: { apiKey?: string; baseUrl?: string } = {};
    if (typeof configuredKey === "string" && configuredKey.trim()) override.apiKey = configuredKey.trim();
    if (typeof configuredBaseUrl === "string" && configuredBaseUrl.trim()) {
      override.baseUrl = configuredBaseUrl.trim();
    }
    if (Object.keys(override).length > 0) providers[id] = override;
  }

  const settings: ImageGenSettings = {
    defaultModel:
      typeof config.defaultModel === "string" && config.defaultModel.trim()
        ? config.defaultModel.trim()
        : "gpt-image-2",
  };
  if (typeof config.outputDir === "string" && config.outputDir.trim()) {
    settings.outputDir = config.outputDir.trim();
  }
  if (Object.keys(providers).length > 0) settings.providers = providers;
  return settings;
}

function buildProvider(id: BuiltInProviderId, settings: ImageGenSettings): ResolvedProvider {
  const override = settings.providers?.[id];
  const provider: ResolvedProvider = {
    id,
    api: DEFAULT_API_STYLE[id],
    baseUrl: override?.baseUrl || DEFAULT_BASE_URL[id],
    name: PROVIDER_DISPLAY_NAME[id],
    builtIn: true,
  };
  const apiKey = override?.apiKey || process.env[ENV_VARS[id]];
  if (apiKey) provider.apiKey = apiKey;
  return provider;
}

export function resolveModel(
  modelOrAlias: string,
  settings: ImageGenSettings,
): ResolvedModel | { error: string } {
  const requested = modelOrAlias.trim();
  if (!requested) return { error: "Image model id is empty." };

  const builtIn = BUILT_IN_MODELS.find(
    (entry) => entry.id === requested || entry.aliases?.includes(requested),
  );
  if (builtIn) {
    return {
      provider: buildProvider(builtIn.provider, settings),
      remoteId: builtIn.id,
      requestedId: requested,
    };
  }

  const slash = requested.indexOf("/");
  if (slash > 0) {
    const providerId = requested.slice(0, slash);
    const remoteId = requested.slice(slash + 1);
    if (isBuiltInProviderId(providerId) && remoteId) {
      return {
        provider: buildProvider(providerId, settings),
        remoteId,
        requestedId: requested,
      };
    }
  }

  return {
    error: `Unknown image model "${requested}". Known ids: ${listKnownModelIds().join(", ")}. OpenRouter models may use openrouter/<vendor>/<model>.`,
  };
}

export function listKnownModelIds(): string[] {
  return BUILT_IN_MODELS.flatMap((model) => [model.id, ...(model.aliases ?? [])]);
}

export function listConfiguredProviders(settings: ImageGenSettings): ResolvedProvider[] {
  return PROVIDER_IDS.map((id) => buildProvider(id, settings)).filter((provider) => provider.apiKey);
}

function isBuiltInProviderId(value: string): value is BuiltInProviderId {
  return PROVIDER_IDS.includes(value as BuiltInProviderId);
}
