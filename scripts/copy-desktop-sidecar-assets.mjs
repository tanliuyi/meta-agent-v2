import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repoRoot, "packages", "desktop", "src", "main", "pi", "extensions", "pi-subagents");
const outputRoot = join(repoRoot, "packages", "desktop", "out", "sidecar", "main", "pi", "extensions", "pi-subagents");

mkdirSync(outputRoot, { recursive: true });
for (const directory of ["agents", "prompts", "skills"]) {
  cpSync(join(sourceRoot, directory), join(outputRoot, directory), { recursive: true });
}
for (const file of ["LICENSE", "UPSTREAM.md", "README.upstream.md", "CHANGELOG.upstream.md", "package.upstream.json"]) {
  cpSync(join(sourceRoot, file), join(outputRoot, file));
}
