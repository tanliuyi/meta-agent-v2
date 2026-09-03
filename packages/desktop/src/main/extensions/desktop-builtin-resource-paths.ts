import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve a builtin skill from source, sidecar output, or the packaged main bundle. */
export function getBuiltinSkillPath(moduleUrl: string, pluginId: string): string {
  const relativePath = `skills/${pluginId}/SKILL.md`;
  const candidates = [
    new URL(`./extensions/${pluginId}/${relativePath}`, moduleUrl),
    new URL(`../pi/extensions/${pluginId}/${relativePath}`, moduleUrl),
    new URL(`../sidecar/main/pi/extensions/${pluginId}/${relativePath}`, moduleUrl),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  return fileURLToPath(candidates[0]);
}
