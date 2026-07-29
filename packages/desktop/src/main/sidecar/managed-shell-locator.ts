import { existsSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

export interface ManagedShellLocatorOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appDir: string;
  platform?: NodeJS.Platform;
}

export interface GitBashLocatorOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

export function locateManagedBash(options: ManagedShellLocatorOptions): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const root = options.isPackaged
    ? join(options.resourcesPath, "managed-shell")
    : resolve(options.appDir, "../../output/managed-shell");
  const shellPath = join(root, "bin", "bash.exe");
  return existsSync(shellPath) ? shellPath : undefined;
}

/** Locate Git for Windows without accepting WSL, Cygwin, or an arbitrary bash.exe on PATH. */
export function locateGitForWindowsBash(options: GitBashLocatorOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const env = options.env ?? process.env;
  const candidates = [
    ...[env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
      .filter((root): root is string => Boolean(root))
      .map((root) => win32.join(root, "Git", "bin", "bash.exe")),
    ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")] : []),
  ];
  const exists = options.exists ?? existsSync;
  return [...new Set(candidates)].find((path) => exists(path));
}
