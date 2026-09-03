import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { JsonValue } from "../../../shared/contracts.ts";
import type {
  DesktopExtensionSource,
  DesktopPluginMethodDefinition,
  PluginApiCatalogV1,
  ResolvedExtensionEntry,
} from "../../../shared/desktop-extension-contracts.ts";
import { normalizePluginSchema } from "../extensions/legacy-plugin-adapter.ts";
import { canonicalJson, snapshotJson } from "./plugin-call-json.ts";

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const METHOD_NAME_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
const FORBIDDEN_METHOD_NAMES = new Set(["then", "constructor", "prototype", "__proto__"]);
const ALLOWED_FORMATS = new Set(["uri", "date-time", "email", "uuid", "hostname", "ipv4", "ipv6"]);
const FORBIDDEN_SCHEMA_KEYS = new Set(["$ref", "$id", "default", "transform", "codec"]);
const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "anyOf",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "description",
  "title",
  "examples",
]);
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const MAX_METHOD_DESCRIPTION_LENGTH = 4_096;
const CAPTURED_TOOL_RESULT_SCHEMA = Type.Object({ text: Type.String() }, { additionalProperties: false });

type CapturedPluginTool = ToolDefinition<TSchema, unknown, unknown>;

export interface RegisteredDesktopPluginMethod {
  readonly pluginId: string;
  readonly primarySkill: string;
  readonly entryId: string;
  readonly source: DesktopExtensionSource;
  readonly name: string;
  readonly description: string;
  readonly concurrency: "serial" | "parallel";
  readonly parameters: object;
  readonly result: object;
  readonly execute: DesktopPluginMethodDefinition["execute"];
  readonly prepareArguments?: (args: unknown) => unknown;
  readonly validateParameters: (value: unknown) => boolean;
  readonly validateResult: (value: unknown) => boolean;
}

export type PluginMethodRegistry = ReadonlyMap<string, ReadonlyMap<string, RegisteredDesktopPluginMethod>>;

interface StagedPlugin {
  entryId: string;
  pluginId: string;
  catalog?: PluginApiCatalogV1;
  kind: "declaration" | "tools";
  methods: RegisteredDesktopPluginMethod[];
}

export class DesktopPluginRegistryBuilder {
  private readonly committed = new Map<string, StagedPlugin>();
  private readonly pending = new Map<string, StagedPlugin>();
  private state: "active" | "discarded" = "active";

  stage(entry: ResolvedExtensionEntry, declaration: unknown): void {
    this.assertActive();
    const { pluginId, catalog } = this.requirePluginMetadata(entry);
    const root = readPlainObject(declaration, ["schemaVersion", "methods"]);
    if (root.schemaVersion !== 1 || !Array.isArray(root.methods) || root.methods.length === 0) {
      throw new Error("PLUGIN_DECLARATION_INVALID");
    }
    const methods = root.methods.map((value) => this.stageMethod(entry, pluginId, value));
    if (new Set(methods.map((method) => method.name)).size !== methods.length) {
      throw new Error("PLUGIN_DUPLICATE_METHOD");
    }
    this.pending.set(entry.id, { entryId: entry.id, pluginId, catalog, kind: "declaration", methods });
  }

  stageTool(entry: ResolvedExtensionEntry, value: unknown): void {
    this.assertActive();
    const existing = this.pending.get(entry.id);
    const { pluginId, catalog } = existing ?? this.requirePluginMetadata(entry);
    const tool = validateCapturedTool(value);
    const staged =
      existing?.kind === "tools"
        ? existing
        : { entryId: entry.id, pluginId, catalog, kind: "tools" as const, methods: [] };
    if (staged.pluginId !== pluginId || staged.methods.some((method) => method.name === tool.name)) {
      throw new Error("PLUGIN_DUPLICATE_METHOD");
    }
    staged.methods.push(this.stageCapturedTool(entry, pluginId, tool));
    this.pending.set(entry.id, staged);
  }

  registerRuntimeTool(entry: ResolvedExtensionEntry, value: unknown): PluginMethodRegistry {
    this.assertActive();
    const { pluginId } = this.requirePluginMetadata(entry);
    const committed = this.committed.get(pluginId);
    if (!committed || committed.entryId !== entry.id) throw new Error("PLUGIN_GENERATION_STALE");
    const tool = validateCapturedTool(value);
    if (committed.methods.some((method) => method.name === tool.name)) throw new Error("PLUGIN_DUPLICATE_METHOD");
    committed.methods.push(this.stageCapturedTool(entry, pluginId, tool));
    return this.snapshot();
  }

  commit(entryId: string): void {
    this.assertActive();
    const staged = this.pending.get(entryId);
    if (!staged) return;
    const existing = this.committed.get(staged.pluginId);
    if (existing && existing.entryId !== entryId) throw new Error("PLUGIN_DUPLICATE_ID");
    this.validateCatalog(staged);
    this.pending.delete(entryId);
    this.committed.set(staged.pluginId, staged);
  }

  rollback(entryId: string): void {
    this.pending.delete(entryId);
  }

  finalize(): PluginMethodRegistry {
    this.assertActive();
    if (this.pending.size > 0) throw new Error("PLUGIN_DECLARATION_UNCOMMITTED");
    return this.snapshot();
  }

  discard(): void {
    this.pending.clear();
    this.committed.clear();
    this.state = "discarded";
  }

  private stageMethod(entry: ResolvedExtensionEntry, pluginId: string, value: unknown): RegisteredDesktopPluginMethod {
    const method = readPlainObject(value, ["name", "description", "parameters", "result", "concurrency", "execute"]);
    if (
      typeof method.name !== "string" ||
      method.name.length > 64 ||
      !METHOD_NAME_PATTERN.test(method.name) ||
      FORBIDDEN_METHOD_NAMES.has(method.name) ||
      typeof method.description !== "string" ||
      method.description.length === 0 ||
      method.description.length > MAX_METHOD_DESCRIPTION_LENGTH ||
      (method.concurrency !== undefined && method.concurrency !== "serial" && method.concurrency !== "parallel") ||
      typeof method.execute !== "function"
    ) {
      throw new Error("PLUGIN_DECLARATION_INVALID");
    }
    const parameters = validatePluginSchemaProfile(method.parameters, true);
    const result = validatePluginSchemaProfile(method.result, false);
    const parametersValidator = Compile(parameters as TSchema);
    const resultValidator = Compile(result as TSchema);
    return Object.freeze({
      pluginId,
      primarySkill: entry.pluginCallSkill ?? entry.id,
      entryId: entry.id,
      source: entry.source,
      name: method.name,
      description: method.description,
      concurrency: method.concurrency ?? "serial",
      parameters,
      result,
      execute: method.execute as DesktopPluginMethodDefinition["execute"],
      validateParameters: (candidate: unknown) => parametersValidator.Check(candidate),
      validateResult: (candidate: unknown) => resultValidator.Check(candidate),
    });
  }

  private stageCapturedTool(
    entry: ResolvedExtensionEntry,
    pluginId: string,
    tool: CapturedPluginTool,
  ): RegisteredDesktopPluginMethod {
    const parameters = normalizePluginSchema(tool.parameters);
    const result = validatePluginSchemaProfile(CAPTURED_TOOL_RESULT_SCHEMA, false);
    const parametersValidator = Compile(tool.parameters);
    const resultValidator = Compile(result as TSchema);
    const execute: DesktopPluginMethodDefinition["execute"] = async (params, signal, context) => {
      const extensionContext = context.toolContext as ExtensionContext | undefined;
      if (!extensionContext) throw new Error("Plugin extension context is unavailable");
      const toolResult = await tool.execute(
        context.callId,
        params,
        signal,
        (update: AgentToolResult<unknown>) => context.reportProgress({ text: toolResultText(update) }),
        extensionContext,
      );
      const textParts: string[] = [];
      for (const part of toolResult.content) {
        if (part.type === "text") textParts.push(part.text);
        else {
          context.attach({ type: "image", data: part.data, mimeType: part.mimeType });
          textParts.push("[image attachment]");
        }
      }
      return { text: textParts.join("\n") };
    };
    return Object.freeze({
      pluginId,
      primarySkill: entry.pluginCallSkill ?? entry.id,
      entryId: entry.id,
      source: entry.source,
      name: tool.name,
      description: tool.description,
      concurrency: tool.executionMode === "parallel" ? "parallel" : "serial",
      parameters,
      result,
      ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
      execute,
      validateParameters: (candidate: unknown) => parametersValidator.Check(candidate),
      validateResult: (candidate: unknown) => resultValidator.Check(candidate),
    });
  }

  private requirePluginMetadata(entry: ResolvedExtensionEntry): {
    pluginId: string;
    catalog?: PluginApiCatalogV1;
  } {
    const pluginId = entry.pluginId ?? entry.id;
    if (
      !pluginId ||
      !PLUGIN_ID_PATTERN.test(pluginId) ||
      (!entry.capabilities.includes("plugin-methods.provide") && !entry.capabilities.includes("tools.register"))
    ) {
      throw new Error("PLUGIN_DECLARATION_UNAUTHORIZED");
    }
    return {
      pluginId,
      ...(entry.pluginCallCatalog ? { catalog: parsePluginApiCatalog(entry.pluginCallCatalog) } : {}),
    };
  }

  private validateCatalog(staged: StagedPlugin): void {
    if (staged.methods.length === 0) throw new Error("PLUGIN_DECLARATION_INVALID");
    if (!staged.catalog) return;
    if (staged.catalog.pluginId !== staged.pluginId) {
      throw new Error("PLUGIN_CATALOG_DRIFT");
    }
    const catalogMethods = staged.catalog.methods.map((value) => normalizeCatalogMethod(value));
    if (staged.kind === "tools") {
      const documentedNames = new Set(catalogMethods.map((method) => method.name));
      if (staged.methods.some((method) => !documentedNames.has(method.name))) throw new Error("PLUGIN_CATALOG_DRIFT");
      return;
    }
    const methods = staged.methods.map(({ name, description, parameters, result, concurrency }) => ({
      name,
      description,
      parameters,
      result,
      concurrency,
    }));
    if (
      catalogMethods.length !== methods.length ||
      canonicalJson([...catalogMethods].sort((left, right) => left.name.localeCompare(right.name))) !==
        canonicalJson([...methods].sort((left, right) => left.name.localeCompare(right.name)))
    ) {
      throw new Error("PLUGIN_CATALOG_DRIFT");
    }
  }

  private snapshot(): PluginMethodRegistry {
    const registry = new Map<string, ReadonlyMap<string, RegisteredDesktopPluginMethod>>();
    for (const [pluginId, staged] of this.committed) {
      registry.set(pluginId, new Map(staged.methods.map((method) => [method.name, method])));
    }
    return registry;
  }

  private assertActive(): void {
    if (this.state !== "active") throw new Error("PLUGIN_GENERATION_STALE");
  }
}

function validateCapturedTool(value: unknown): CapturedPluginTool {
  if (!value || typeof value !== "object") throw new Error("PLUGIN_DECLARATION_INVALID");
  const tool = value as Partial<CapturedPluginTool>;
  if (
    typeof tool.name !== "string" ||
    tool.name.length > 64 ||
    !METHOD_NAME_PATTERN.test(tool.name) ||
    FORBIDDEN_METHOD_NAMES.has(tool.name) ||
    typeof tool.description !== "string" ||
    tool.description.length === 0 ||
    !tool.parameters ||
    typeof tool.parameters !== "object" ||
    typeof tool.execute !== "function" ||
    (tool.executionMode !== undefined && tool.executionMode !== "sequential" && tool.executionMode !== "parallel") ||
    (tool.prepareArguments !== undefined && typeof tool.prepareArguments !== "function")
  ) {
    throw new Error("PLUGIN_DECLARATION_INVALID");
  }
  return tool as CapturedPluginTool;
}

function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "[image attachment]")).join("\n");
}

export function validatePluginSchemaProfile(value: unknown, parametersRoot: boolean): object {
  const schema = snapshotSchema(value, 0);
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) throw new Error("PLUGIN_SCHEMA_INVALID");
  validateSchemaNode(schema, parametersRoot);
  return schema;
}

function snapshotSchema(value: unknown, depth: number): Record<string, JsonValue> {
  if (depth > MAX_SCHEMA_DEPTH || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PLUGIN_SCHEMA_INVALID");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("PLUGIN_SCHEMA_INVALID");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("PLUGIN_SCHEMA_INVALID");
  const output: Record<string, JsonValue> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new Error("PLUGIN_SCHEMA_INVALID");
    if (!descriptor.enumerable) continue;
    output[key] = snapshotSchemaValue(descriptor.value, depth + 1);
  }
  return output;
}

function snapshotSchemaValue(value: unknown, depth: number): JsonValue {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error("PLUGIN_SCHEMA_INVALID");
  if (Array.isArray(value)) return value.map((item) => snapshotSchemaValue(item, depth + 1));
  if (value && typeof value === "object") return snapshotSchema(value, depth);
  return snapshotJson(value, MAX_SCHEMA_BYTES);
}

function validateSchemaNode(schema: Record<string, JsonValue>, parametersRoot: boolean): void {
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_SCHEMA_KEYS.has(key) || !ALLOWED_SCHEMA_KEYS.has(key)) throw new Error("PLUGIN_SCHEMA_INVALID");
  }
  if (typeof schema.format === "string" && !ALLOWED_FORMATS.has(schema.format))
    throw new Error("PLUGIN_SCHEMA_INVALID");
  if (parametersRoot && schema.type !== "object") {
    throw new Error("PLUGIN_SCHEMA_INVALID");
  }
  const validKind =
    schema.type === "object" ||
    schema.type === "array" ||
    schema.type === "string" ||
    schema.type === "number" ||
    schema.type === "integer" ||
    schema.type === "boolean" ||
    schema.type === "null" ||
    "const" in schema ||
    Array.isArray(schema.anyOf);
  if (!validKind) throw new Error("PLUGIN_SCHEMA_INVALID");
  if (schema.type === "object") {
    const properties = schema.properties;
    if (
      !properties ||
      typeof properties !== "object" ||
      Array.isArray(properties) ||
      schema.additionalProperties === undefined ||
      typeof schema.additionalProperties !== "boolean"
    ) {
      throw new Error("PLUGIN_SCHEMA_INVALID");
    }
    if (parametersRoot && schema.additionalProperties !== false) throw new Error("PLUGIN_SCHEMA_INVALID");
    for (const child of Object.values(properties)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("PLUGIN_SCHEMA_INVALID");
      validateSchemaNode(child as Record<string, JsonValue>, false);
    }
  }
  if (schema.type === "array") {
    if (Array.isArray(schema.items)) {
      for (const child of schema.items) validateSchemaNode(child as Record<string, JsonValue>, false);
    } else if (schema.items && typeof schema.items === "object") {
      validateSchemaNode(schema.items as Record<string, JsonValue>, false);
    } else {
      throw new Error("PLUGIN_SCHEMA_INVALID");
    }
  }
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length < 2) throw new Error("PLUGIN_SCHEMA_INVALID");
    for (const child of schema.anyOf) {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("PLUGIN_SCHEMA_INVALID");
      validateSchemaNode(child as Record<string, JsonValue>, false);
    }
  }
  if (parametersRoot && schema.additionalProperties !== false) throw new Error("PLUGIN_SCHEMA_INVALID");
}

export function parsePluginApiCatalog(value: unknown): PluginApiCatalogV1 {
  const catalog = readPlainObject(value, ["schemaVersion", "pluginId", "methods"]);
  if (
    catalog.schemaVersion !== 1 ||
    typeof catalog.pluginId !== "string" ||
    !PLUGIN_ID_PATTERN.test(catalog.pluginId) ||
    !Array.isArray(catalog.methods) ||
    catalog.methods.length === 0 ||
    catalog.methods.length > 64
  ) {
    throw new Error("PLUGIN_CATALOG_DRIFT");
  }
  const methods = catalog.methods.map(normalizeCatalogMethod);
  const names = methods.map((method) => method.name);
  if (new Set(names).size !== methods.length) {
    throw new Error("PLUGIN_DUPLICATE_METHOD");
  }
  if (names.some((name, index) => name !== [...names].sort((left, right) => left.localeCompare(right))[index])) {
    throw new Error("PLUGIN_CATALOG_DRIFT");
  }
  return { schemaVersion: 1, pluginId: catalog.pluginId, methods } as unknown as PluginApiCatalogV1;
}

function normalizeCatalogMethod(value: unknown): {
  name: string;
  description: string;
  parameters: object;
  result: object;
  concurrency: "serial" | "parallel";
} {
  const method = readPlainObject(value, ["name", "description", "parameters", "result", "concurrency"]);
  if (
    typeof method.name !== "string" ||
    method.name.length > 64 ||
    !METHOD_NAME_PATTERN.test(method.name) ||
    FORBIDDEN_METHOD_NAMES.has(method.name) ||
    typeof method.description !== "string" ||
    method.description.length === 0 ||
    method.description.length > MAX_METHOD_DESCRIPTION_LENGTH ||
    (method.concurrency !== "serial" && method.concurrency !== "parallel")
  ) {
    throw new Error("PLUGIN_CATALOG_DRIFT");
  }
  return {
    name: method.name,
    description: method.description,
    parameters: validatePluginSchemaProfile(method.parameters, true),
    result: validatePluginSchemaProfile(method.result, false),
    concurrency: method.concurrency,
  };
}

function readPlainObject(value: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PLUGIN_DECLARATION_INVALID");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("PLUGIN_DECLARATION_INVALID");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("PLUGIN_DECLARATION_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !allowedKeys.includes(key))) throw new Error("PLUGIN_DECLARATION_INVALID");
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) throw new Error("PLUGIN_DECLARATION_INVALID");
    output[key] = descriptor.value;
  }
  return output;
}

export function validatePluginValue(
  method: Pick<RegisteredDesktopPluginMethod, "validateParameters">,
  value: unknown,
): JsonValue {
  const snapshot = snapshotJson(value);
  if (!method.validateParameters(snapshot)) throw new Error("PLUGIN_METHOD_INVALID_ARGUMENTS");
  return snapshot;
}
