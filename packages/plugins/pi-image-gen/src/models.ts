import type { ApiStyle, BuiltInProviderId } from "./types.ts";

export type BuiltInModelEntry = {
  id: string;
  aliases?: string[];
  provider: BuiltInProviderId;
};

export const BUILT_IN_MODELS: BuiltInModelEntry[] = [
  { id: "gpt-image-2", provider: "openai" },
  { id: "gemini-3-pro-image", aliases: ["nano-banana-pro"], provider: "gemini" },
  { id: "gemini-3.1-flash-image", aliases: ["nano-banana-2"], provider: "gemini" },
  {
    id: "gemini-3.1-flash-lite-image",
    aliases: ["nano-banana-2-lite"],
    provider: "gemini",
  },
  { id: "gemini-2.5-flash-image", aliases: ["nano-banana"], provider: "gemini" },
  { id: "qwen-image-2.0-pro", provider: "dashscope" },
  { id: "qwen-image-2.0", provider: "dashscope" },
  { id: "doubao-seedream-5-0-pro-260128", aliases: ["seedream-5-pro"], provider: "ark" },
  {
    id: "doubao-seedream-5-0-260128",
    aliases: ["seedream-5", "seedream"],
    provider: "ark",
  },
  {
    id: "doubao-seedream-5-0-lite-260128",
    aliases: ["seedream-5-lite"],
    provider: "ark",
  },
  { id: "doubao-seedream-4-5-251128", aliases: ["seedream-4-5"], provider: "ark" },
  { id: "doubao-seedream-4-0-250828", aliases: ["seedream-4"], provider: "ark" },
];

export const DEFAULT_BASE_URL: Record<BuiltInProviderId, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  dashscope: "https://dashscope.aliyuncs.com/api/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ark: "https://ark.cn-beijing.volces.com/api/v3",
};

export const DEFAULT_API_STYLE: Record<BuiltInProviderId, ApiStyle> = {
  openai: "openai",
  gemini: "gemini",
  dashscope: "dashscope",
  openrouter: "openrouter",
  ark: "ark",
};

export const ENV_VARS: Record<BuiltInProviderId, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ark: "ARK_API_KEY",
};

export const PROVIDER_DISPLAY_NAME: Record<BuiltInProviderId, string> = {
  openai: "OpenAI",
  gemini: "Google Gemini",
  dashscope: "Alibaba DashScope",
  openrouter: "OpenRouter",
  ark: "Volcengine Ark",
};
