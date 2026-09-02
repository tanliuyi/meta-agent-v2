import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = ["SKILL.md", "data/diagram.json", "apps/web/src/App.jsx", "apps/server/src/server.mjs", "apps/collaboration/src/server.mjs", "packages/diagram-cli/src/main.mjs", "packages/diagram-model/src/validate-diagram.mjs"];
for (const file of required) await access(resolve(root, file));
JSON.parse(await readFile(resolve(root, "data/diagram.json"), "utf8"));
console.log(`skill source valid: ${required.length} required files`);
