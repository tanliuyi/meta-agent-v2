import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPathWithin, samePath } from "../../path-identity.ts";

/** Creates a Desktop-owned directory without following symlinks below a trusted root. */
export async function ensureCodexManagedDirectory(path: string, trustedRoot: string): Promise<string> {
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  const trustedInfo = await lstat(trustedRoot);
  if (!trustedInfo.isDirectory() || trustedInfo.isSymbolicLink()) {
    throw new Error(`Codex managed trusted root is not a regular directory: ${trustedRoot}`);
  }
  const canonicalTrustedRoot = await realpath(trustedRoot);
  const suffix = relative(resolve(trustedRoot), resolve(path));
  if (isOutside(suffix)) throw new Error("Codex managed path escapes the trusted root");
  let current = canonicalTrustedRoot;
  for (const component of suffix.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Codex managed path is not a regular directory: ${current}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  const canonical = await realpath(current);
  if (!samePath(canonical, current)) throw new Error(`Codex managed path contains a symbolic-link component: ${path}`);
  return canonical;
}

export function assertCodexManagedChild(canonicalRoot: string, candidate: string): void {
  if (!isPathWithin(canonicalRoot, candidate)) throw new Error("Codex managed path escapes the Desktop root");
}

function isOutside(relativePath: string): boolean {
  return isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
