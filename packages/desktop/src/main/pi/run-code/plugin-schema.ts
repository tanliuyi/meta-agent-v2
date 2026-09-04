import type { TSchema } from "typebox";

/** Convert harmless TypeBox annotations to the lossless JSON schema profile used by run_code. */
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
