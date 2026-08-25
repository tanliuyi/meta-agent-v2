import { join } from "node:path";

/** Desktop-owned plugin payloads must stay outside Pi's auto-discovered extension directory. */
export function resolveMarketplaceExtensionRoot(userDataDir: string): string {
  return join(userDataDir, "plugins", "extensions");
}
