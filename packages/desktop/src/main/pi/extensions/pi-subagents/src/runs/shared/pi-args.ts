import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Resolve a source extension path against the compiled sidecar sibling. */
export function resolveRuntimeExtensionPath(extensionPath: string, baseDir: string): string {
  const source = isAbsolute(extensionPath) ? extensionPath : resolve(baseDir, extensionPath);
  if (existsSync(source)) return source;
  if (source.endsWith(".ts")) {
    const compiled = `${source.slice(0, -3)}.js`;
    if (existsSync(compiled)) return compiled;
  }
  return source;
}
