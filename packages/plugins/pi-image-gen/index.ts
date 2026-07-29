import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createImageGenSettings,
  listConfiguredProviders,
  listKnownModelIds,
  resolveModel,
} from "./src/config.ts";
import { errorMessageForUser, toLogSummary } from "./src/errors.ts";
import { generateImage } from "./src/generate.ts";
import type {
  ApiStyle,
  DesktopImageGenConfig,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
} from "./src/types.ts";

const QUALITY_VALUES = ["low", "medium", "high", "auto"] as const;

type ImageToolCapabilities = {
  api: ApiStyle | null;
  quality: boolean;
  maxImages: number;
};

export default function piImageGenExtension(pi: ExtensionAPI): void {
  const settings = createImageGenSettings(pi.getConfig<DesktopImageGenConfig>());
  let sessionCwd = process.cwd();
  const capabilities = resolveImageToolCapabilities(settings);

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
  });

  pi.registerTool({
    name: "image_generate",
    label: "Generate Image",
    description:
      "Generate or edit raster images with the image model configured for this Desktop plugin. Pass local file paths or http(s) URLs in image for edits or reference conditioning. The tool writes new image files without overwriting existing files and returns absolute paths. It does not accept base64 or data: URI inputs.",
    promptSnippet:
      "Generate or edit raster images such as photos, illustrations, textures, sprites, and mockups.",
    promptGuidelines: buildImageGuidelines(capabilities),
    parameters: buildImageToolParameters(capabilities),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const generateParams: GenerateImageParams = { prompt: params.prompt };
        if (params.image) generateParams.image = params.image;
        if (params.n !== undefined) generateParams.n = params.n;
        if (params.size !== undefined) generateParams.size = params.size;
        if (typeof params.quality === "string") generateParams.quality = params.quality;
        if (params.filename !== undefined) generateParams.filename = params.filename;
        if (params.outputDir !== undefined) generateParams.outputDir = params.outputDir;
        const result = await generateImage(generateParams, {
          cwd: ctx.cwd || sessionCwd,
          settings,
          signal,
        });
        return {
          content: [{ type: "text", text: formatToolResultText(result) }],
          details: result,
        };
      } catch (error) {
        console.error(`[pi-image-gen] image_generate failed: ${toLogSummary(error)}`);
        throw new Error(`image_generate failed: ${errorMessageForUser(error)}`);
      }
    },
  });

  pi.registerCommand("image-gen", {
    description: "Inspect image generation configuration or generate an image",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw === "" || raw === "list") {
        ctx.ui.notify(formatConfiguration(settings), "info");
        return;
      }
      if (raw.startsWith("generate ")) {
        const prompt = raw.slice("generate ".length).trim();
        if (!prompt) {
          ctx.ui.notify("Usage: /image-gen generate <prompt>", "error");
          return;
        }
        try {
          const result = await generateImage({ prompt }, { cwd: ctx.cwd, settings, signal: ctx.signal });
          ctx.ui.notify(formatCommandSummary(result), "info");
        } catch (error) {
          console.error(`[pi-image-gen] command failed: ${toLogSummary(error)}`);
          ctx.ui.notify(`Image generation failed: ${errorMessageForUser(error)}`, "error");
        }
        return;
      }
      ctx.ui.notify("Usage: /image-gen [list|generate <prompt>]", "error");
    },
  });
}

function resolveImageToolCapabilities(settings: ImageGenSettings): ImageToolCapabilities {
  const resolved = resolveModel(settings.defaultModel, settings);
  if ("error" in resolved) return { api: null, quality: false, maxImages: 8 };
  const quality =
    (resolved.provider.api === "openai" || resolved.provider.api === "openrouter") &&
    /(?:^|\/)gpt-image/i.test(resolved.remoteId);
  return {
    api: resolved.provider.api,
    quality,
    maxImages: resolved.provider.api === "dashscope" ? 6 : 8,
  };
}

function buildImageToolParameters(capabilities: ImageToolCapabilities) {
  return Type.Object({
    prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Generation or edit prompt." }),
    image: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        maxItems: 8,
        description: "Reference image file paths or http(s) URLs.",
      }),
    ),
    n: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: capabilities.maxImages,
        description: `Variants of one prompt. Maximum ${capabilities.maxImages} for the active provider.`,
      }),
    ),
    size: Type.Optional(Type.String({ minLength: 3, maxLength: 64, description: sizeDescription(capabilities.api) })),
    ...(capabilities.quality
      ? {
          quality: Type.Optional(
            StringEnum(QUALITY_VALUES, {
              description: "OpenAI gpt-image quality: low, medium, high, or auto.",
            }),
          ),
        }
      : {}),
    filename: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100, description: "Filename prefix without extension." }),
    ),
    outputDir: Type.Optional(
      Type.String({ minLength: 1, maxLength: 4096, description: "Output directory, relative to cwd or absolute." }),
    ),
  });
}

function buildImageGuidelines(capabilities: ImageToolCapabilities): string[] {
  const guidelines = [
    "Use image_generate for bitmap assets, not repo-native icons, logos, SVG diagrams, CSS, or canvas graphics.",
    "Use image_generate image inputs for edits and reference conditioning. Label each image's role in the prompt and state what must remain unchanged.",
    "image_generate n creates variants of one prompt. Use separate calls for distinct assets.",
    "Render every generated image in the final response using the markdown line returned by image_generate, and report its saved path.",
  ];
  if (capabilities.quality) {
    guidelines.push(
      "Use image_generate quality low for drafts and high for final assets or text-heavy images.",
    );
  }
  return guidelines;
}

function sizeDescription(api: ApiStyle | null): string {
  if (api === "ark") {
    return 'Image size such as "2048x2048". Seedream 5 and 4.5 require 2K or larger.';
  }
  if (api === "dashscope") {
    return 'Image size such as "1328x1328". The plugin converts this to DashScope width*height syntax.';
  }
  return 'Provider-specific image size such as "1024x1024".';
}

function formatConfiguration(settings: ImageGenSettings): string {
  const resolved = resolveModel(settings.defaultModel, settings);
  const route =
    "error" in resolved
      ? resolved.error
      : `${resolved.provider.name} (${resolved.provider.api}), API key ${resolved.provider.apiKey ? "configured" : "missing"}`;
  const configured = listConfiguredProviders(settings).map((provider) => provider.name).join(", ") || "none";
  return [
    `Default model: ${settings.defaultModel}`,
    `Route: ${route}`,
    `Output directory: ${settings.outputDir ?? ".pi/images"}`,
    `Providers with keys: ${configured}`,
    `Known models: ${listKnownModelIds().join(", ")}`,
  ].join("\n");
}

function formatToolResultText(result: ImageGenResult): string {
  return [
    `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}). Render these lines verbatim in the final response:`,
    "",
    ...result.images.flatMap((image) => {
      const markdown = `![${altFromPath(image.path)}](${image.path})`;
      return image.revisedPrompt
        ? [markdown, `> revised prompt: ${image.revisedPrompt}`]
        : [markdown];
    }),
  ].join("\n");
}

function formatCommandSummary(result: ImageGenResult): string {
  return [
    `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}):`,
    ...result.images.map((image) => image.path),
  ].join("\n");
}

function altFromPath(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? "image";
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).replace(/\]/g, "\\]") || "image";
}

export { createImageGenSettings, resolveModel } from "./src/config.ts";
export { generateImage } from "./src/generate.ts";
export type { DesktopImageGenConfig, GenerateImageParams, ImageGenResult } from "./src/types.ts";
