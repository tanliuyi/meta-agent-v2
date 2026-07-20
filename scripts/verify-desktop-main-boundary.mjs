import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repoRoot, "packages", "desktop", "out", "main");
const forbidden = [
  /@earendil-works\/pi-(?:ai|agent-core|tui)(?:\/[^"']*)?/,
  /@earendil-works\/pi-coding-agent(?:["']|\/(?!models-config(?:["']|\/)))/,
  /\bSessionRuntime\b/,
];
const violations = [];
for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
  if (!entry.endsWith(".js") && !entry.endsWith(".cjs") && !entry.endsWith(".mjs")) continue;
  const path = join(root, entry);
  const source = readFileSync(path, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(source)) violations.push(`${entry}: ${pattern.source}`);
  }
}
if (violations.length > 0) {
  throw new Error(`Electron main contains Pi runtime imports:\n${violations.join("\n")}`);
}
console.log("Verified Electron main has no Pi runtime import graph");
