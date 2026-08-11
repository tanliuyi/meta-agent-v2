import cohereModelIcon from "@renderer/assets/models/cohere.svg";
import geminiModelIcon from "@renderer/assets/models/gemini.svg";
import grokModelIcon from "@renderer/assets/models/grok.svg";
import metaModelIcon from "@renderer/assets/models/meta.svg";
import qwenModelIcon from "@renderer/assets/models/qwen.svg";
import zhipuModelIcon from "@renderer/assets/models/zhipu.svg";
import { providerIcon } from "@renderer/shared/lib/provider-icons";
import type { ReactNode } from "react";
import { ModelIconImage } from "./model-icon-image.tsx";

interface ModelIconMatcher {
  pattern: RegExp;
  source: string | undefined;
}

/**
 * Model-family marks take precedence over the transport provider. This matters
 * for aggregators such as OpenRouter, Together, and GitHub Copilot.
 */
const MODEL_ICON_MATCHERS: readonly ModelIconMatcher[] = [
  { pattern: /\bclaude(?:[-_.:/]|$)/, source: providerIcon("anthropic") },
  { pattern: /\b(?:gpt|o[134])(?:[-_.:/]|$)/, source: providerIcon("openai") },
  { pattern: /\b(?:gemini|gemma)(?:[-_.:/]|$)/, source: geminiModelIcon },
  { pattern: /\bdeepseek(?:[-_.:/]|$)/, source: providerIcon("deepseek") },
  { pattern: /\bqwen(?:[-_.:/]|$)/, source: qwenModelIcon },
  { pattern: /\b(?:kimi|moonshotai)(?:[-_.:/]|$)/, source: providerIcon("kimi-coding") },
  { pattern: /\b(?:glm|chatglm)(?:[-_.:/]|$)/, source: zhipuModelIcon },
  { pattern: /\bminimax(?:ai)?(?:[-_.:/]|$)/, source: providerIcon("minimax") },
  {
    pattern: /\b(?:mistral|codestral|devstral|magistral|ministral|pixtral|voxtral)(?:[-_.:/]|$)/,
    source: providerIcon("mistral"),
  },
  { pattern: /\b(?:llama|meta-llama)(?:\d|[-_.:/]|$)/, source: metaModelIcon },
  { pattern: /\bgrok(?:[-_.:/]|$)/, source: grokModelIcon },
  { pattern: /\b(?:mimo|xiaomi)(?:[-_.:/]|$)/, source: providerIcon("xiaomi") },
  { pattern: /\b(?:ling|ring|inclusionai)(?:[-_.:/]|$)/, source: providerIcon("ant-ling") },
  { pattern: /\bcommand(?:[-_.:/]|$)/, source: cohereModelIcon },
];

export function getProviderIconSource(provider: string): string | undefined {
  return providerIcon(provider);
}

export function getModelIconSource(provider: string, modelId: string, modelName: string): string | undefined {
  const searchable = `${provider} ${modelId} ${modelName}`.toLowerCase();
  for (const matcher of MODEL_ICON_MATCHERS) {
    if (matcher.source && matcher.pattern.test(searchable)) return matcher.source;
  }
  return providerIcon(provider);
}

export function modelSelectorIcon(provider: string, modelId: string, modelName: string): ReactNode {
  const source = getModelIconSource(provider, modelId, modelName);
  return source ? <ModelIconImage src={source} /> : undefined;
}
