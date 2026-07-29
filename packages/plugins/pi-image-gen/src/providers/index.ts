import { ImageGenError } from '../errors.ts';
import type { ApiStyle, ImageProviderAdapter } from '../types.ts';
import { arkAdapter } from './ark.ts';
import { dashscopeAdapter } from './dashscope.ts';
import { geminiAdapter } from './gemini.ts';
import { openaiAdapter } from './openai.ts';
import { openrouterAdapter } from './openrouter.ts';

const ADAPTERS: Record<ApiStyle, ImageProviderAdapter> = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  dashscope: dashscopeAdapter,
  openrouter: openrouterAdapter,
  ark: arkAdapter,
};

export function getAdapter(api: ApiStyle): ImageProviderAdapter {
  const adapter = ADAPTERS[api];
  if (!adapter) throw new ImageGenError(`Unsupported api "${api}".`, `unsupported api "${api}"`);
  return adapter;
}
