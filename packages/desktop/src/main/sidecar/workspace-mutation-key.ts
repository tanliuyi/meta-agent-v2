import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getRepoRoot } from "../pi/extensions/pi-rewind/src/core.ts";

/** Canonical mutation scope shared by Desktop projects that live in one Git repository. */
export async function resolveWorkspaceMutationKey(cwd: string): Promise<string> {
  const root = await getRepoRoot(cwd).catch(() => resolve(cwd));
  const canonical = await realpath(resolve(root)).catch(() => resolve(root));
  const normalized = canonical.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
