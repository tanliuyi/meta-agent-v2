import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { JsonValue } from "../../../shared/contracts.ts";
import type {
  DesktopExtensionSource,
  DesktopPluginMethodDefinition,
  PluginApiCatalogV1,
  ResolvedExtensionEntry,
} from "../../../shared/desktop-extension-contracts.ts";
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
  readonly validateParameters: (value: unknown) => boolean;
  readonly validateResult: (value: unknown) => boolean;
}

export type PluginMethodRegistry = ReadonlyMap<string, ReadonlyMap<string, RegisteredDesktopPluginMethod>>;

interface StagedPlugin {
  pluginId: string;
  methods: RegisteredDesktopPluginMethod[];
}

export class DesktopPluginRegistryBuilder {
  private readonly committed = new Map<string, RegisteredDesktopPluginMethod[]>();
  private readonly pending = new Map<string, StagedPlugin>();
  private state: "open" | "frozen" | "discarded" = "open";

  stage(entry: ResolvedExtensionEntry, declaration: unknown): void {
    this.assertOpen();
    const pluginId = entry.pluginId ?? (entry.source === "development" ? undefined : entry.id);
    if (!pluginId || !PLUGIN_ID_PATTERN.test(pluginId)) throw new Error("PLUGIN_DECLARATION_UNAUTHORIZED");
    if (
      !entry.capabilities.includes("plugin-methods.provide") ||
      !entry.pluginCallSkill ||
      !entry.pluginCallCatalog ||
      entry.pluginCallCatalog.methods.length === 0
    ) {
      throw new Error("PLUGIN_DECLARATION_UNAUTHORIZED");
    }
    const root = readPlainObject(declaration, ["schemaVersion", "methods"]);
    if (root.schemaVersion !== 1 || !Array.isArray(root.methods) || root.methods.length === 0) {
      throw new Error("PLUGIN_DECLARATION_INVALID");
    }
    const methods = root.methods.map((value) => this.stageMethod(entry, pluginId, value));
    if (new Set(methods.map((method) => method.name)).size !== methods.length) {
      throw new Error("PLUGIN_DUPLICATE_METHOD");
    }
    const catalog = parsePluginApiCatalog(entry.pluginCallCatalog);
    const catalogMethods = catalog.methods.map((value) => normalizeCatalogMethod(value));
    if (
      catalog.schemaVersion !== 1 ||
      catalog.pluginId !== pluginId ||
      catalogMethods.length !== methods.length ||
      canonicalJson([...catalogMethods].sort((left, right) => left.name.localeCompare(right.name))) !==
        canonicalJson(
          methods
            .map(({ name, description, parameters, result, concurrency }) => ({
              name,
              description,
              parameters,
              result,
              concurrency,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        )
    ) {
      throw new Error("PLUGIN_CATALOG_DRIFT");
    }
    this.pending.set(entry.id, { pluginId, methods });
  }

  commit(entryId: string): void {
    this.assertOpen();
    const staged = this.pending.get(entryId);
    if (!staged) return;
    if (this.committed.has(staged.pluginId)) throw new Error("PLUGIN_DUPLICATE_ID");
    this.pending.delete(entryId);
    this.committed.set(staged.pluginId, staged.methods);
  }

  rollback(entryId: string): void {
    this.pending.delete(entryId);
  }

  finalize(): PluginMethodRegistry {
    this.assertOpen();
    if (this.pending.size > 0) throw new Error("PLUGIN_DECLARATION_UNCOMMITTED");
    const registry = new Map<string, ReadonlyMap<string, RegisteredDesktopPluginMethod>>();
    for (const [pluginId, methods] of this.committed) {
      registry.set(pluginId, new Map(methods.map((method) => [method.name, method])));
    }
    this.state = "frozen";
    return registry;
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
      method.description.length > 500 ||
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
      primarySkill: entry.pluginCallSkill as string,
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

  private assertOpen(): void {
    if (this.state !== "open") throw new Error("PLUGIN_GENERATION_STALE");
  }
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
    method.description.length > 500 ||
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
