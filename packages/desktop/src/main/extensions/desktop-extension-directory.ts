import { lstat, realpath } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export interface ResolvedDevelopmentEntry {
  entryPath: string;
  displayName: string;
  displayPath: string;
}

const ALLOWED_ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const CONVENTIONAL_ENTRY_NAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/** Resolves an internal development adapter from a selected file or conventional directory entry. */
export async function resolveDevelopmentEntry(selectedPath: string): Promise<ResolvedDevelopmentEntry> {
  const info = await lstat(selectedPath);
  if (info.isSymbolicLink()) throw new Error("Development extension entry must not be a symbolic link");
  if (info.isFile()) return resolveDevelopmentFile(selectedPath, basename(selectedPath));
  if (!info.isDirectory()) throw new Error("Development extension entry must be a regular file or directory");
  for (const candidate of CONVENTIONAL_ENTRY_NAMES) {
    const entryPath = join(selectedPath, candidate);
    try {
      const entry = await lstat(entryPath);
      if (entry.isFile() && !entry.isSymbolicLink()) {
        return resolveDevelopmentFile(entryPath, basename(selectedPath));
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  throw new Error("Development extension directory has no index entry file");
}

async function resolveDevelopmentFile(path: string, displayName: string): Promise<ResolvedDevelopmentEntry> {
  if (!ALLOWED_ENTRY_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error("Development extension entry must be a JavaScript or TypeScript file");
  }
  const entryPath = await realpath(path);
  return { entryPath, displayName, displayPath: displayName };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
