import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist-skill");
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "scripts"), { recursive: true });
await cp(resolve(root, "SKILL.md"), resolve(out, "SKILL.md"));
await cp(resolve(root, "data"), resolve(out, "data"), { recursive: true });
await cp(resolve(root, "references"), resolve(out, "references"), { recursive: true });
const serverSource = await readFile(resolve(root, "apps/server/src/server.mjs"), "utf8");
await writeFile(resolve(out, "scripts/server.mjs"), serverSource.replace('resolve(dirname(fileURLToPath(import.meta.url)), "../../..")', 'resolve(dirname(fileURLToPath(import.meta.url)), "..")').replace('join(skillDir, "dist", "app")', 'join(skillDir, "app")'));
await cp(resolve(root, "packages/diagram-cli/src/main.mjs"), resolve(out, "scripts/eia-flow.mjs"));
await cp(resolve(root, "apps/collaboration/src/server.mjs"), resolve(out, "scripts/collaboration.mjs"));
await cp(resolve(root, "dist", "app"), resolve(out, "app"), { recursive: true });
await writeFile(resolve(out, "package.json"), JSON.stringify({ name: "generate-eia-process-flow-diagrams", private: true, type: "module" }, null, 2));
console.log(`skill built: ${out}`);
