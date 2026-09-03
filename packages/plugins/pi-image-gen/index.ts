import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createImageGenSettings, resolveModel } from "./src/config.ts";
import { errorMessageForUser, toLogSummary } from "./src/errors.ts";
import { generateImage } from "./src/generate.ts";
import type {
  ApiStyle,
  DesktopImageGenConfig,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
} from "./src/types.ts";

const DECLARATION_CAPABILITIES: ImageToolCapabilities = { api: null, quality: true, maxImages: 8 };
const IMAGE_METHOD_PARAMETERS = buildImageToolParameters(DECLARATION_CAPABILITIES);
const IMAGE_METHOD_RESULT = Type.Object({ text: Type.String() }, { additionalProperties: false });

interface PluginMethodContext {
  readonly cwd: string;
}

type ImageToolCapabilities = {
  api: ApiStyle | null;
  quality: boolean;
  maxImages: number;
};

let activeSettings: ImageGenSettings = createImageGenSettings({});

type DesktopExtensionAPI = ExtensionAPI & {
  getConfig<T = Readonly<Record<string, string | number | boolean>>>(): Readonly<T>;
};

export default function piImageGenExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => ({
    skillPaths: [fileURLToPath(new URL("./skills/pi-image-gen/SKILL.md", import.meta.url))],
  }));
  const desktopApi = pi as DesktopExtensionAPI;
  activeSettings = createImageGenSettings(desktopApi.getConfig<DesktopImageGenConfig>());
}

export const desktopPlugin = {
  schemaVersion: 1 as const,
  methods: [
    {
      name: "image_generate",
      description:
        "Generate or edit raster images with the configured image model. Pass local file paths or http(s) URLs in image for edits or reference conditioning. The method writes new image files without overwriting existing files and returns absolute paths.",
      parameters: IMAGE_METHOD_PARAMETERS,
      result: IMAGE_METHOD_RESULT,
      concurrency: "serial" as const,
      async execute(
        params: GenerateImageParams,
        signal: AbortSignal,
        ctx: PluginMethodContext,
      ): Promise<{ text: string }> {
        try {
          const result = await generateImage(params, {
            cwd: getContextCwd(ctx),
            settings: activeSettings,
            signal,
          });
          return { text: formatToolResultText(result) };
        } catch (error) {
          console.error(`[pi-image-gen] image_generate failed: ${toLogSummary(error)}`);
          throw new Error(`image_generate failed: ${errorMessageForUser(error)}`);
        }
      },
    },
  ],
};

export const pluginCallCatalog = {
  schemaVersion: 1 as const,
  pluginId: "pi.image-gen",
  methods: desktopPlugin.methods.map(({ name, description, parameters, result, concurrency }) => ({
    name,
    description,
    parameters,
    result,
    concurrency,
  })),
};

function getContextCwd(ctx: PluginMethodContext): string {
  return ctx.cwd;
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
  return Type.Object(
    {
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
              Type.Union(
                [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")],
                { description: "Image quality: low, medium, high, or auto." },
              ),
            ),
          }
        : {}),
      filename: Type.Optional(
        Type.String({ minLength: 1, maxLength: 100, description: "Filename prefix without extension." }),
      ),
      outputDir: Type.Optional(
        Type.String({ minLength: 1, maxLength: 4096, description: "Output directory, relative to cwd or absolute." }),
      ),
    },
    { additionalProperties: false },
  );
}

function sizeDescription(api: ApiStyle | null): string {
  if (api === "ark") return 'Image size such as "2048x2048". Seedream 5 and 4.5 require 2K or larger.';
  if (api === "dashscope") return 'Image size such as "1328x1328". The plugin converts this to DashScope width*height syntax.';
  return 'Provider-specific image size such as "1024x1024".';
}

function formatToolResultText(result: ImageGenResult): string {
  return [
    `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}). Render these lines verbatim in the final response:`,
    "",
    ...result.images.flatMap((image) => {
      const markdown = `![${altFromPath(image.path)}](${image.path})`;
      return image.revisedPrompt ? [markdown, `> revised prompt: ${image.revisedPrompt}`] : [markdown];
    }),
  ].join("\n");
}

function altFromPath(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? "image";
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).replace(/\]/g, "\\]") || "image";
}

export { createImageGenSettings, resolveModel } from "./src/config.ts";
export { generateImage } from "./src/generate.ts";
export { IMAGE_GEN_CONFIGURATION_SCHEMA, IMAGE_GEN_CONFIGURATION_SCHEMA_JSON } from "./src/configuration.ts";
export type { DesktopImageGenConfig, GenerateImageParams, ImageGenResult } from "./src/types.ts";
