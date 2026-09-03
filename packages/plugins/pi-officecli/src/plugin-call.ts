import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { createRunner, type CliRunner } from "./cli.ts";
import { resolveConfig } from "./config.ts";
import { registerInspectTools } from "./tools/inspect.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerWriteTools } from "./tools/write.ts";

interface PluginMethodContext {
  readonly callId: string;
  readonly methodName: string;
  readonly toolContext?: unknown;
  attach(attachment: { type: "image"; data: string; mimeType: string; name?: string }): void;
}

type OfficeTool = ToolDefinition<TSchema, unknown>;

const pluginResultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const declarationRunner = createRunner(resolveConfig({}));
let activeTools = new Map<string, OfficeTool>();

function collectOfficeTools(runner: CliRunner): OfficeTool[] {
  const tools: OfficeTool[] = [];
  const registrationApi = {
    registerTool(tool: OfficeTool): void {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  registerReadTools(registrationApi, runner);
  registerWriteTools(registrationApi, runner);
  registerInspectTools(registrationApi, runner);
  return tools;
}

function normalizePluginSchema(schema: TSchema): object {
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

function toMethod(tool: OfficeTool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: normalizePluginSchema(tool.parameters),
    result: pluginResultSchema,
    concurrency: "serial" as const,
    async execute(params: unknown, signal: AbortSignal, ctx: PluginMethodContext): Promise<{ text: string }> {
      const tool = activeTools.get(ctx.methodName ?? "");
      if (!tool) throw new Error(`OfficeCLI method ${ctx.methodName ?? "unknown"} is unavailable`);
      const extensionContext = ctx.toolContext as ExtensionContext | undefined;
      if (!extensionContext) throw new Error("Plugin extension context is unavailable");
      const result = await tool.execute(
        ctx.callId,
        params as Static<TSchema>,
        signal,
        undefined,
        extensionContext,
      ) as AgentToolResult<unknown>;
      return { text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
    },
  };
}

const declarationTools = collectOfficeTools(declarationRunner);

export const desktopPlugin = {
  schemaVersion: 1 as const,
  methods: declarationTools.map(toMethod),
};

export const pluginCallCatalog = {
  schemaVersion: 1 as const,
  pluginId: "pi.officecli",
  methods: [...desktopPlugin.methods]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description, parameters, result, concurrency }) => ({
      name,
      description,
      parameters,
      result,
      concurrency,
    })),
};

export type DesktopExtensionAPI = ExtensionAPI & {
  getConfig<T = Readonly<Record<string, string | number | boolean>>>(): Readonly<T>;
};

export function activateOfficePlugin(pi: ExtensionAPI): void {
  const desktopApi = pi as DesktopExtensionAPI;
  const runner = createRunner(resolveConfig(desktopApi.getConfig()));
  activeTools = new Map(collectOfficeTools(runner).map((tool) => [tool.name, tool]));
}

export { normalizePluginSchema };
