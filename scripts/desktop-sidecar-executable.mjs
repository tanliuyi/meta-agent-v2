import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function resolveElectronSidecarExecutable(
  executable,
  {
    platform = process.platform,
    fileExists = existsSync,
    requireHelper = false,
  } = {},
) {
  if (platform !== "darwin") return executable;
  const executableName = basename(executable);
  const helperName = `${executableName} Helper`;
  const helperExecutable = join(
    dirname(dirname(executable)),
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName,
  );
  if (fileExists(helperExecutable)) return helperExecutable;
  if (requireHelper) throw new Error(`macOS Electron sidecar Helper is missing: ${helperExecutable}`);
  return executable;
}
