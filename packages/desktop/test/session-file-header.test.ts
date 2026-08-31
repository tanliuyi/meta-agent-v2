import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionFileHeader } from "../src/sidecar/session-file-header.ts";

const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

describe("session file header", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "desktop-session-header-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("skips blank and malformed lines before the session header", async () => {
    const sessionFile = join(root, "sessions", "session.jsonl");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(sessionFile, `\nnot-json\n${JSON.stringify({ type: "session", id: "thread", cwd: root })}`, "utf8");

    await expect(readSessionFileHeader(sessionFile, "project", "thread")).resolves.toEqual({
      sessionFile,
      cwd: root,
    });
  });

  it("rejects a header beyond the bounded scan", async () => {
    const sessionFile = join(root, "session.jsonl");
    const header = JSON.stringify({ type: "session", id: "thread", cwd: root });
    writeFileSync(sessionFile, `${"x".repeat(MAX_SESSION_HEADER_SCAN_BYTES)}\n${header}\n`, "utf8");

    await expect(readSessionFileHeader(sessionFile, "project", "thread")).rejects.toThrow(
      "Session identity does not match",
    );
  });
});
