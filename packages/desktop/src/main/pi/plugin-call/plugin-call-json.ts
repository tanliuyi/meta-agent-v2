import type { JsonValue } from "../../../shared/contracts.ts";

export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_BYTES = 16 * 1024 * 1024;

export function snapshotJson(value: unknown, maxBytes = MAX_JSON_BYTES): JsonValue {
  const seen = new WeakSet<object>();
  const result = visit(value, 0, seen);
  const encoded = JSON.stringify(result);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new Error("PLUGIN_RESPONSE_LIMIT_EXCEEDED");
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(snapshotJson(value)));
}

function visit(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error("PLUGIN_JSON_DEPTH_EXCEEDED");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PLUGIN_INVALID_JSON");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) throw new Error("PLUGIN_INVALID_JSON");
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("PLUGIN_INVALID_JSON");
  const output: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) output[key] = visit((value as Record<string, unknown>)[key], depth + 1, seen);
  seen.delete(value);
  return output;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]);
    return output;
  }
  return value;
}
