import { join } from "node:path";

/** Desktop-managed root for installed Codex plugin copies. */
export function resolveCodexExtensionRoot(userDataDir: string): string {
  return join(userDataDir, "plugins", "codex-extensions");
}
