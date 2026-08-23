import { savePiShellPath } from "./pi-settings.ts";

/** Persist the Desktop shell selection in the effective Pi settings scope. */
export function saveShellRuntimePath(cwd: string, agentDir: string, path: string): Promise<void> {
  return savePiShellPath(cwd, agentDir, path);
}
