import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadWorkerBinding } from "../src/shared/sidecar-contracts.ts";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  runtimeCreate: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    list: mocks.listSessions,
    create: vi.fn(),
    open: vi.fn(),
  },
}));

vi.mock("../src/main/pi/session-runtime.ts", () => ({
  SessionRuntime: { create: mocks.runtimeCreate },
}));

import { ThreadWorkerService } from "../src/sidecar/thread-worker-service.ts";

describe("ThreadWorkerService open validation", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "thread-worker-service-"));
    mocks.listSessions.mockReset();
    mocks.runtimeCreate.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a session identity mismatch before opening or migrating the file", async () => {
    const cwd = join(root, "project");
    const sessionFile = join(root, "sessions", "session.jsonl");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const original = `${JSON.stringify({
      type: "session",
      id: "actual-thread",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    })}\n`;
    writeFileSync(sessionFile, original, { encoding: "utf8" });
    mocks.listSessions.mockResolvedValue([{ id: "actual-thread", path: sessionFile }]);

    const binding: ThreadWorkerBinding = {
      mode: "open",
      projectId: "project",
      cwd,
      agentDir: join(root, "agent"),
      threadId: "requested-thread",
      sessionFile,
      extensionSet: {
        generation: "extensions-generation",
        projectId: "project",
        entries: [],
        diagnostics: [],
        resolvedAt: 0,
      },
    };

    await expect(
      ThreadWorkerService.create({ role: "thread", value: binding }, { emit: () => undefined }),
    ).rejects.toThrow("Session identity does not match");
    expect(mocks.runtimeCreate).not.toHaveBeenCalled();
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
  });
});
