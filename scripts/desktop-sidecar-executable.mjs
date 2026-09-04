import { existsSync } from "node:fs";
import { posix } from "node:path";

/** 解析打包 Electron 在 macOS 上隐藏的 Helper sidecar 可执行文件。 */
export function resolveElectronSidecarExecutable(
  executable,
  {
    platform = process.platform,
    fileExists = existsSync,
    requireHelper = false,
  } = {},
) {
  if (platform !== "darwin") return executable;
  const executableName = posix.basename(executable);
  const helperName = `${executableName} Helper`;
  const helperExecutable = posix.join(
    posix.dirname(posix.dirname(executable)),
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
