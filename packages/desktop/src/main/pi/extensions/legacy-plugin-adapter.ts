import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import type { JsonValue } from "../../../shared/contracts.ts";
import type {
  DesktopPluginMethodDefinition,
  PluginApiCatalogV1,
  PluginMethodExecutionContext,
} from "../../../shared/desktop-extension-contracts.ts";

export type LegacyPluginTool = ToolDefinition<TSchema, unknown>;

const pluginResultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

export function createLegacyPluginMethods(tools: readonly LegacyPluginTool[]): DesktopPluginMethodDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: normalizePluginSchema(tool.parameters) as TSchema,
    result: pluginResultSchema,
    concurrency: "serial" as const,
    async execute(params: unknown, signal: AbortSignal, ctx: PluginMethodExecutionContext) {
      const extensionContext = ctx.toolContext as ExtensionContext | undefined;
      if (!extensionContext) throw new Error("Plugin extension context is unavailable");
      const result = await tool.execute(ctx.callId, params, signal, undefined, extensionContext);
      const textParts: string[] = [];
      for (const part of result.content) {
        if (part.type === "text") textParts.push(part.text);
        if (part.type === "image") {
          ctx.attach({ type: "image", data: part.data, mimeType: part.mimeType });
          textParts.push("[image attachment]");
        }
      }
      return { text: textParts.join("\n") };
    },
  }));
}

export function createLegacyPluginCatalog(
  pluginId: string,
  methods: readonly DesktopPluginMethodDefinition[],
): PluginApiCatalogV1 {
  return {
    schemaVersion: 1,
    pluginId,
    methods: [...methods]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, description, parameters, result, concurrency }) => ({
        name,
        description,
        parameters: parameters as unknown as Record<string, JsonValue>,
        result: result as unknown as Record<string, JsonValue>,
        concurrency: concurrency ?? "serial",
      })),
  };
}

/** Convert harmless TypeBox annotations to the profile's lossless JSON forms. */
export function normalizePluginSchema(schema: TSchema): object {
  return normalizeValue(schema, 0) as object;
}

function normalizeValue(value: unknown, depth: number): unknown {
  if (depth > 64) throw new Error("PLUGIN_SCHEMA_INVALID");
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "deprecated" || key === "default") continue;
    if (key === "enum" && Array.isArray(child)) {
      result.anyOf = child.map((item) => ({ const: item }));
      continue;
    }
    if (key === "patternProperties") {
      result.properties ??= {};
      result.additionalProperties = true;
      continue;
    }
    result[key] = normalizeValue(child, depth + 1);
  }
  if (Array.isArray(result.anyOf) && result.anyOf.length === 1) {
    const [only] = result.anyOf;
    if (only && typeof only === "object" && "const" in only) {
      result.const = (only as { const: unknown }).const;
      delete result.anyOf;
    }
  }
  if (result.type === "object") {
    if (!result.properties || typeof result.properties !== "object" || Array.isArray(result.properties)) {
      result.properties = {};
    }
    result.additionalProperties ??= false;
  }
  return result;
}
