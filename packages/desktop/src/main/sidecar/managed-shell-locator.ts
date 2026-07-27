import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ManagedShellLocatorOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appDir: string;
  platform?: NodeJS.Platform;
}

export function locateManagedBash(options: ManagedShellLocatorOptions): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const root = options.isPackaged
    ? join(options.resourcesPath, "managed-shell")
    : resolve(options.appDir, "../../output/managed-shell");
  const shellPath = join(root, "bin", "bash.exe");
  return existsSync(shellPath) ? shellPath : undefined;
}
