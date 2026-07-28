/**
 * Desktop models.json metadata using public pi-ai APIs.
 *
 * Generates built-in provider metadata for the models editor form.
 * Uses @earendil-works/pi-ai public API; does not depend on coding-agent.
 */

import { type Api, type BuiltinProvider, getModels, getProviders, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelsConfigMetadata } from "../../shared/models-config-contracts.ts";

// Built-in provider display names inlined from coding-agent's former
// provider-display-names.ts. These are display labels used by the editor UI.
const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "ant-ling": "Ant Ling",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  "azure-openai-responses": "Azure OpenAI Responses",
  deepseek: "DeepSeek",
  nvidia: "NVIDIA NIM",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  "amazon-bedrock": "Amazon Bedrock",
  mistral: "Mistral",
  groq: "Groq",
  cerebras: "Cerebras",
  "github-copilot": "GitHub Copilot",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  xai: "xAI",
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel AI Gateway",
  zai: "ZAI Coding Plan (Global)",
  "zai-coding-cn": "ZAI Coding Plan (China)",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  radius: "Radius",
  huggingface: "Hugging Face",
  fireworks: "Fireworks",
  together: "Together AI",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  "qwen-token-plan": "Qwen Token Plan",
  "qwen-token-plan-cn": "Qwen Token Plan (China)",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
};

/** Generate editor metadata from public pi-ai compat API. */
export function getModelsConfigMetadata(): ModelsConfigMetadata {
  const builtInProviders = getProviders().map((provider) => {
    const displayName = BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ?? provider;
    const models = getModels(provider as BuiltinProvider).map(toBuiltInModelMetadata);
    const baseUrls = new Set(models.map((model) => model.baseUrl));
    const apis = new Set(models.map((model) => model.api));
    return {
      id: provider,
      displayName,
      defaultConfig: {
        name: displayName,
        baseUrl: baseUrls.size === 1 ? models[0]?.baseUrl : undefined,
        api: apis.size === 1 ? models[0]?.api : undefined,
      },
      models,
    };
  });
  const knownApis = [
    ...new Set(builtInProviders.flatMap((provider) => provider.models.map((model) => model.api))),
  ].sort();
  return { knownApis, builtInProviders };
}

function toBuiltInModelMetadata(model: Model<Api>): ModelsConfigMetadata["builtInProviders"][number]["models"][number] {
  const { provider: _provider, ...definition } = structuredClone(model);
  return {
    ...definition,
    name: definition.name ?? definition.id,
    api: definition.api ?? "",
  };
}
