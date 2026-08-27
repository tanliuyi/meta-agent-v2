import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { readSessionHeader as readPiSessionHeader } from "@earendil-works/pi-coding-agent";

export interface SessionFileHeader {
  sessionFile: string;
  cwd: string;
}

export async function readSessionFileHeader(
  sessionFile: string,
  projectId: string,
  threadId: string,
): Promise<SessionFileHeader> {
  const requestedPath = resolve(sessionFile);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(requestedPath);
  } catch {
    throw new Error(`Session file does not exist before open: ${requestedPath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Session file is not a regular file before open: ${requestedPath}`);
  }
  const header = readPiSessionHeader(requestedPath);
  if (!header || header.id !== threadId || typeof header.cwd !== "string" || header.cwd.length === 0) {
    throw new Error(`Session identity does not match ${projectId}/${threadId}: ${requestedPath}`);
  }
  return { sessionFile: requestedPath, cwd: header.cwd };
}
