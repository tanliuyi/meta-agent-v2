import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopSourceRoot = join(repoRoot, "packages", "desktop", "src", "main", "pi");
const defaultOutputRoot = join(repoRoot, "packages", "desktop", "out", "sidecar");

export function copyDesktopSidecarAssets(outputRoot = defaultOutputRoot) {
  const subagentsSourceRoot = join(desktopSourceRoot, "extensions", "pi-subagents");
  const subagentsOutputRoot = join(outputRoot, "main", "pi", "extensions", "pi-subagents");
  mkdirSync(subagentsOutputRoot, { recursive: true });
  for (const directory of ["agents", "prompts", "skills"]) {
    cpSync(join(subagentsSourceRoot, directory), join(subagentsOutputRoot, directory), { recursive: true });
  }
  for (const file of ["LICENSE", "UPSTREAM.md", "README.upstream.md", "CHANGELOG.upstream.md", "package.upstream.json"]) {
    cpSync(join(subagentsSourceRoot, file), join(subagentsOutputRoot, file));
  }

  cpSync(join(desktopSourceRoot, "skills"), join(outputRoot, "main", "pi", "skills"), { recursive: true });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  copyDesktopSidecarAssets();
}
