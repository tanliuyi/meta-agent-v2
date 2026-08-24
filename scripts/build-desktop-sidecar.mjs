import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { cleanDesktopSidecarOutput, synchronizeDesktopSidecarOutput } from "./clean-desktop-sidecar-output.mjs";
import { generateDesktopSidecarManifests } from "./generate-desktop-sidecar-manifest.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "packages", "desktop");
const outputParent = join(desktopRoot, "out");
const packagedParent = join(desktopRoot, "output");
const outputRoot = join(outputParent, "sidecar");
const packagedRoot = join(packagedParent, "pi-sidecar");
const tsgoPath = join(repoRoot, "node_modules", "@typescript", "native-preview", "bin", "tsgo.js");

mkdirSync(outputParent, { recursive: true });
mkdirSync(packagedParent, { recursive: true });
const releaseLock = await lockfile.lock(outputParent, {
  realpath: false,
  stale: 10 * 60_000,
  update: 30_000,
  retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 2_000, randomize: true },
});
let stagedRoot;
let stagedPackagedRoot;

try {
  stagedRoot = mkdtempSync(join(outputParent, ".sidecar-build-"));
  stagedPackagedRoot = mkdtempSync(join(packagedParent, ".pi-sidecar-build-"));
  execFileSync(process.execPath, [tsgoPath, "-p", "tsconfig.sidecar.json", "--outDir", stagedRoot], {
    cwd: desktopRoot,
    stdio: "inherit",
  });
  await generateDesktopSidecarManifests(stagedRoot, stagedPackagedRoot);
  synchronizeDesktopSidecarOutput(stagedPackagedRoot, packagedRoot);
  synchronizeDesktopSidecarOutput(stagedRoot, outputRoot);
} finally {
  try {
    if (stagedRoot) cleanDesktopSidecarOutput(stagedRoot);
    if (stagedPackagedRoot) cleanDesktopSidecarOutput(stagedPackagedRoot);
  } finally {
    await releaseLock();
  }
}
