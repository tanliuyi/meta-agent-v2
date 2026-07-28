import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../shared/contracts.ts";

const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<string, string>> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  "ant-ling": "Ring-2.6-1T",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  "azure-openai-responses": "gpt-5.4",
  "openai-codex": "gpt-5.5",
  radius: "auto",
  nvidia: "nvidia/nemotron-3-super-120b-a12b",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  "github-copilot": "gpt-5.4",
  openrouter: "moonshotai/kimi-k2.6",
  "vercel-ai-gateway": "zai/glm-5.1",
  xai: "grok-4.5",
  groq: "openai/gpt-oss-120b",
  cerebras: "zai-glm-4.7",
  zai: "glm-5.1",
  "zai-coding-cn": "glm-5.1",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  together: "moonshotai/Kimi-K2.6",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k2.6",
  "kimi-coding": "kimi-for-coding",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  "qwen-token-plan": "qwen3.7-max",
  "qwen-token-plan-cn": "qwen3.7-max",
  xiaomi: "mimo-v2.5-pro",
  "xiaomi-token-plan-cn": "mimo-v2.5-pro",
  "xiaomi-token-plan-ams": "mimo-v2.5-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export interface ThinkingConfiguration {
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
}

export function resolveThinkingConfiguration(
  model: Model<Api> | undefined,
  requestedLevel: ThinkingLevel,
): ThinkingConfiguration {
  if (!model) return { thinkingLevel: "off", thinkingLevels: ["off"] };
  return {
    thinkingLevel: clampThinkingLevel(model, requestedLevel) as ThinkingLevel,
    thinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
  };
}

export function selectInitialModel(
  modelRuntime: ModelRuntime,
  available: readonly Model<Api>[],
  defaults: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
): { model: Model<Api> | undefined; thinkingLevel: ThinkingLevel } {
  const configured =
    defaults.provider && defaults.modelId ? modelRuntime.getModel(defaults.provider, defaults.modelId) : undefined;
  const configuredAvailable = Boolean(configured && modelRuntime.hasConfiguredAuth(configured.provider));
  const model = configuredAvailable
    ? configured
    : (Object.entries(DEFAULT_MODEL_PER_PROVIDER)
        .map(([provider, modelId]) =>
          available.find((candidate) => candidate.provider === provider && candidate.id === modelId),
        )
        .find((candidate) => candidate !== undefined) ?? available[0]);
  const requested = configuredAvailable ? (defaults.thinkingLevel ?? "medium") : "medium";
  return { model, thinkingLevel: resolveThinkingConfiguration(model, requested).thinkingLevel };
}
