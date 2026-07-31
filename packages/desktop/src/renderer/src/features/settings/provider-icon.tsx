import amazonBedrockIcon from "@renderer/assets/providers/amazon-bedrock.svg";
import anthropicIcon from "@renderer/assets/providers/anthropic.svg";
import azureOpenaiIcon from "@renderer/assets/providers/azure-openai-responses.svg";
import cerebrasIcon from "@renderer/assets/providers/cerebras.svg";
import cloudflareIcon from "@renderer/assets/providers/cloudflare-ai-gateway.svg";
import deepseekIcon from "@renderer/assets/providers/deepseek.svg";
import fireworksIcon from "@renderer/assets/providers/fireworks.svg";
import githubCopilotIcon from "@renderer/assets/providers/github-copilot.svg";
import googleIcon from "@renderer/assets/providers/google.svg";
import googleVertexIcon from "@renderer/assets/providers/google-vertex.svg";
import groqIcon from "@renderer/assets/providers/groq.svg";
import huggingfaceIcon from "@renderer/assets/providers/huggingface.svg";
import minimaxIcon from "@renderer/assets/providers/minimax.svg";
import mistralIcon from "@renderer/assets/providers/mistral.svg";
import nvidiaIcon from "@renderer/assets/providers/nvidia.svg";
import openaiIcon from "@renderer/assets/providers/openai.svg";
import opencodeIcon from "@renderer/assets/providers/opencode.svg";
import openrouterIcon from "@renderer/assets/providers/openrouter.svg";
import qwenIcon from "@renderer/assets/providers/qwen-token-plan.svg";
import vercelIcon from "@renderer/assets/providers/vercel-ai-gateway.svg";
import xaiIcon from "@renderer/assets/providers/xai.svg";
import xiaomiIcon from "@renderer/assets/providers/xiaomi.svg";
import zaiIcon from "@renderer/assets/providers/zai.svg";

/**
 * Official brand SVG icons for built-in provider keys.
 *
 * Provider ids without an official SVG icon (e.g. kimi/moonshot, together,
 * radius, ant-ling) resolve to undefined and fall back to the letter avatar.
 */
const PROVIDER_ICONS: Readonly<Record<string, string>> = {
  anthropic: anthropicIcon,
  openai: openaiIcon,
  "openai-codex": openaiIcon,
  "azure-openai-responses": azureOpenaiIcon,
  deepseek: deepseekIcon,
  nvidia: nvidiaIcon,
  google: googleIcon,
  "google-vertex": googleVertexIcon,
  "amazon-bedrock": amazonBedrockIcon,
  mistral: mistralIcon,
  groq: groqIcon,
  cerebras: cerebrasIcon,
  "github-copilot": githubCopilotIcon,
  "cloudflare-ai-gateway": cloudflareIcon,
  "cloudflare-workers-ai": cloudflareIcon,
  xai: xaiIcon,
  openrouter: openrouterIcon,
  "vercel-ai-gateway": vercelIcon,
  zai: zaiIcon,
  "zai-coding-cn": zaiIcon,
  opencode: opencodeIcon,
  "opencode-go": opencodeIcon,
  huggingface: huggingfaceIcon,
  fireworks: fireworksIcon,
  minimax: minimaxIcon,
  "minimax-cn": minimaxIcon,
  "qwen-token-plan": qwenIcon,
  "qwen-token-plan-cn": qwenIcon,
  xiaomi: xiaomiIcon,
  "xiaomi-token-plan-cn": xiaomiIcon,
  "xiaomi-token-plan-ams": xiaomiIcon,
  "xiaomi-token-plan-sgp": xiaomiIcon,
};

/** Resolve the official brand icon for a provider key, if one exists. */
export function providerIcon(key: string): string | undefined {
  return PROVIDER_ICONS[key];
}
