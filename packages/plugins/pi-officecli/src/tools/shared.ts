import path from "node:path";
import { truncateToolOutput } from "../output.ts";

/** Normalize a file argument against the session working directory. */
export function resolveFilePath(file: string, cwd: string): string {
  return path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file);
}

/** Human-readable location for error messages. */
export function describeFile(file: string, cwd: string): string {
  const abs = resolveFilePath(file, cwd);
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

/** Format a tool failure consistently: log the cause, surface a clean message. */
export function toolError(toolName: string, error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  console.error(`[pi-officecli] ${toolName} failed: ${cause}`);
  return new Error(`${toolName} 失败: ${cause}`);
}

/** Build a success result, truncating oversized output with a recovery hint. */
export function textResult(text: string, details: unknown): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return { content: [{ type: "text", text: truncateToolOutput(text) }], details };
}
