import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import piWebAccess from "../vendor/pi-web-access/index.ts";
import { createDesktopApi } from "../desktop-api.ts";

interface PluginMethodContext {
  readonly callId: string;
  readonly methodName: string;
  readonly toolContext?: unknown;
  attach(attachment: { type: "image"; data: string; mimeType: string; name?: string }): void;
}

type WebTool = ToolDefinition<TSchema, unknown>;

const METHOD_NAMES = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
const METHOD_DESCRIPTIONS: Record<(typeof METHOD_NAMES)[number], string> = {
  web_search: "Search the web and return bounded results with source citations.",
  source_check: "Check a claim against web sources and return cited passages.",
  fetch_content: "Fetch readable or raw content from supported URLs and sources.",
  get_search_content: "Retrieve bounded content from a stored web search or fetch response.",
};
const PLUGIN_CALL_CONFIG = {
  webSearch: { enabled: true },
  toolNames: {
    webSearch: "web_search",
    sourceCheck: "source_check",
    fetchContent: "fetch_content",
    getSearchContent: "get_search_content",
  },
};
const pluginResultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
let activeTools = new Map<string, WebTool>();

function captureWebTools(): WebTool[] {
  const tools: WebTool[] = [];
  const captureApi = new Proxy(
    {
      registerTool(tool: WebTool): void {
        tools.push(tool);
      },
    },
    {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return value ?? (() => undefined);
      },
    },
  ) as unknown as ExtensionAPI;
  piWebAccess(createDesktopApi(captureApi), PLUGIN_CALL_CONFIG);
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

function makeMethod(tool: WebTool, methodName: string) {
  return {
    name: methodName,
    description: METHOD_DESCRIPTIONS[methodName],
    parameters: normalizePluginSchema(tool.parameters),
    result: pluginResultSchema,
    concurrency: "serial" as const,
    async execute(params: unknown, signal: AbortSignal, ctx: PluginMethodContext): Promise<{ text: string }> {
      const tool = activeTools.get(ctx.methodName);
      if (!tool) throw new Error(`Web Access method ${ctx.methodName} is unavailable`);
      const extensionContext = ctx.toolContext as ExtensionContext | undefined;
      if (!extensionContext) throw new Error("Plugin extension context is unavailable");
      const result = await tool.execute(
        ctx.callId,
        params as Static<TSchema>,
        signal,
        undefined,
        extensionContext,
      ) as AgentToolResult<unknown>;
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
  };
}

function mapCanonicalTools(tools: readonly WebTool[]): Map<string, WebTool> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const remaining = tools.filter((tool) => !METHOD_NAMES.includes(tool.name as (typeof METHOD_NAMES)[number]));
  return new Map(
    METHOD_NAMES.map((name, index): [string, WebTool | undefined] => [name, byName.get(name) ?? remaining[index]]).filter(
      (entry): entry is [string, WebTool] => entry[1] !== undefined,
    ),
  );
}

const declarationTools = captureWebTools();
const declarationByMethod = mapCanonicalTools(declarationTools);

export const desktopPlugin = {
  schemaVersion: 1 as const,
  methods: METHOD_NAMES.map((name) => {
    const tool = declarationByMethod.get(name);
    if (!tool) throw new Error(`Web Access declaration tool is unavailable: ${name}`);
    return makeMethod(tool, name);
  }),
};

export const pluginCallCatalog = {
  schemaVersion: 1 as const,
  pluginId: "pi.web-access",
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

export function activateWebAccessPlugin(pi: ExtensionAPI): void {
  const captured: WebTool[] = [];
  const captureApi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: WebTool): void => {
          captured.push(tool);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as ExtensionAPI;
  piWebAccess(createDesktopApi(captureApi), PLUGIN_CALL_CONFIG);
  activeTools = mapCanonicalTools(captured);
}

export { normalizePluginSchema };
