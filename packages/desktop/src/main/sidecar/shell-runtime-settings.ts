import { saveSystemPiShellPath } from "./system-pi-settings.ts";

/** Persist the Desktop shell selection in the effective system Pi settings scope. */
export function saveShellRuntimePath(cwd: string, agentDir: string, path: string): Promise<void> {
  return saveSystemPiShellPath(cwd, agentDir, path);
}
