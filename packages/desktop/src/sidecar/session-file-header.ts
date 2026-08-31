import { createReadStream, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseSessionEntries, type SessionHeader } from "@earendil-works/pi-coding-agent";

const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

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

  const stream = createReadStream(requestedPath, { end: MAX_SESSION_HEADER_SCAN_BYTES - 1 });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let header: SessionHeader | undefined;
  let foundEntry = false;

  try {
    for await (const chunk of stream) {
      pending += decoder.write(chunk);
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const entry = parseSessionEntries(pending.slice(0, newlineIndex))[0];
        pending = pending.slice(newlineIndex + 1);
        if (entry) {
          foundEntry = true;
          if (entry.type === "session") header = entry;
          break;
        }
        newlineIndex = pending.indexOf("\n");
      }
      if (foundEntry) break;
    }
    if (!foundEntry && stats.size <= MAX_SESSION_HEADER_SCAN_BYTES) {
      pending += decoder.end();
      const entry = parseSessionEntries(pending)[0];
      if (entry?.type === "session") header = entry;
    }
  } finally {
    stream.destroy();
  }

  if (!header || header.id !== threadId || typeof header.cwd !== "string" || header.cwd.length === 0) {
    throw new Error(`Session identity does not match ${projectId}/${threadId}: ${requestedPath}`);
  }
  return { sessionFile: requestedPath, cwd: header.cwd };
}
