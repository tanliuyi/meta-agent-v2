export type ApiStyle = "openai" | "gemini" | "dashscope" | "openrouter" | "ark";

export type BuiltInProviderId = ApiStyle;

export type DesktopImageGenConfig = {
  defaultModel?: string;
  outputDir?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  dashscopeApiKey?: string;
  dashscopeBaseUrl?: string;
  arkApiKey?: string;
  arkBaseUrl?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
};

export type BuiltInProviderOverride = {
  apiKey?: string;
  baseUrl?: string;
};

export type ImageGenSettings = {
  defaultModel: string;
  outputDir?: string;
  providers?: Partial<Record<BuiltInProviderId, BuiltInProviderOverride>>;
};

export type GenerateImageParams = {
  prompt: string;
  image?: string[];
  n?: number;
  size?: string;
  quality?: string;
  filename?: string;
  outputDir?: string;
};

export type ResolvedImageInput = {
  bytes: Uint8Array;
  mimeType: string;
};

export type GeneratedImage = {
  path: string;
  mimeType: string;
  revisedPrompt?: string;
};

export type ImageGenResult = {
  model: string;
  provider: string;
  images: GeneratedImage[];
};

export type ResolvedProvider = {
  id: BuiltInProviderId;
  api: ApiStyle;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  name: string;
  builtIn: true;
};

export type ResolvedModel = {
  provider: ResolvedProvider;
  remoteId: string;
  requestedId: string;
};

export type ImageProviderAdapter = {
  generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
  ): Promise<RawImageResult[]>;
};

export type RawImageResult = {
  data: { kind: "base64"; bytes: string; mimeType?: string } | { kind: "url"; url: string };
  revisedPrompt?: string;
};
