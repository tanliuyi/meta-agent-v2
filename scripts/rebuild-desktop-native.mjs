import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const electronEntry = createRequire(import.meta.url).resolve("electron");
const electronPackagePath = join(dirname(electronEntry), "package.json");
const electronVersion = JSON.parse(readFileSync(electronPackagePath, "utf8")).version;
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const npmRoot = join(agentDir, "npm");
const nativePackages = ["better-sqlite3"];
const installedPackages = nativePackages.filter((name) => existsSync(join(npmRoot, "node_modules", name)));

if (installedPackages.length === 0) {
  process.exit(0);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  [
    "--prefix",
    npmRoot,
    "rebuild",
    ...installedPackages,
    "--runtime=electron",
    `--target=${electronVersion}`,
    "--dist-url=https://electronjs.org/headers",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
