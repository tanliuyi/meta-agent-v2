import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Ensure node-pty's macOS helper can be launched after npm extracts its prebuilds. */
export function ensureNodePtySpawnHelpersExecutable(nodePtyRoot, platform = process.platform) {
  if (platform !== "darwin") return [];

  const helpers = [
    join(nodePtyRoot, "prebuilds", "darwin-arm64", "spawn-helper"),
    join(nodePtyRoot, "prebuilds", "darwin-x64", "spawn-helper"),
    join(nodePtyRoot, "build", "Release", "spawn-helper"),
  ].filter(existsSync);
  if (helpers.length === 0) throw new Error(`node-pty spawn-helper is missing under ${nodePtyRoot}`);

  const changed = [];
  for (const helper of helpers) {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helper, mode | 0o111);
    changed.push(helper);
  }
  return changed;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
  for (const helper of ensureNodePtySpawnHelpersExecutable(nodePtyRoot)) {
    console.log(`Made node-pty spawn helper executable: ${helper}`);
  }
}
