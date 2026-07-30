import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_WORKSPACE_ID } from "../src/shared/contracts.ts";
import type { ThreadWorkerBinding } from "../src/shared/sidecar-contracts.ts";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  openSession: vi.fn(),
  runtimeCreate: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    list: mocks.listSessions,
    create: mocks.createSession,
    open: mocks.openSession,
  },
}));

vi.mock("../src/main/pi/session-runtime.ts", () => ({
  SessionRuntime: { create: mocks.runtimeCreate },
}));

import { resolveDesktopSessionDirectory } from "../src/sidecar/desktop-session-directory.ts";
import { ThreadWorkerService } from "../src/sidecar/thread-worker-service.ts";

describe("ThreadWorkerService", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "thread-worker-service-"));
    mocks.createSession.mockReset();
    mocks.listSessions.mockReset();
    mocks.openSession.mockReset();
    mocks.runtimeCreate.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves ordinary project session directories on the Pi default", () => {
    expect(resolveDesktopSessionDirectory("project", join(root, "agent"))).toBeUndefined();
  });

  it("creates general workspace sessions in the short fixed directory", async () => {
    const cwd = join(root, "workspaces", "general");
    const agentDir = join(root, "agent");
    const sessionId = "general-thread";
    const sessionFile = join(agentDir, "sessions", "--general--", `${sessionId}.jsonl`);
    const bootstrap = { threadId: sessionId };
    mocks.createSession.mockReturnValue({ getSessionFile: () => sessionFile });
    mocks.runtimeCreate.mockResolvedValue({
      id: sessionId,
      bootstrap: vi.fn().mockReturnValue(bootstrap),
      dispose: vi.fn(),
    });
    const binding: ThreadWorkerBinding = {
      mode: "create",
      projectId: GENERAL_WORKSPACE_ID,
      cwd,
      agentDir,
      sessionId,
      createInput: {
        projectId: GENERAL_WORKSPACE_ID,
        createRequestId: "request",
        extensionSetGeneration: "extensions-generation",
        model: { provider: "provider", id: "model" },
        thinkingLevel: "off",
      },
      extensionSet: {
        generation: "extensions-generation",
        projectId: GENERAL_WORKSPACE_ID,
        entries: [],
        diagnostics: [],
        resolvedAt: 0,
      },
    };

    const result = await ThreadWorkerService.create(
      { role: "thread", value: binding },
      { emit: () => undefined, requestHost: async () => undefined, flushEvents: async () => undefined },
    );

    expect(mocks.createSession).toHaveBeenCalledWith(cwd, join(agentDir, "sessions", "--general--"), {
      id: sessionId,
    });
    expect(result.readyResult).toBe(bootstrap);
  });

  it("opens general workspace sessions with the short directory and original cwd", async () => {
    const cwd = join(root, "workspaces", "general");
    const agentDir = join(root, "agent");
    const sessionId = "general-thread";
    const sessionFile = join(agentDir, "sessions", "--general--", `${sessionId}.jsonl`);
    mkdirSync(join(agentDir, "sessions", "--general--"), { recursive: true });
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
    mocks.openSession.mockReturnValue({});
    mocks.runtimeCreate.mockResolvedValue({
      id: sessionId,
      bootstrap: vi.fn().mockReturnValue({ threadId: sessionId }),
      dispose: vi.fn(),
    });
    const binding: ThreadWorkerBinding = {
      mode: "open",
      projectId: GENERAL_WORKSPACE_ID,
      cwd,
      agentDir,
      threadId: sessionId,
      sessionFile,
      initialUpdatedAt: 4_000,
      extensionSet: {
        generation: "extensions-generation",
        projectId: GENERAL_WORKSPACE_ID,
        entries: [],
        diagnostics: [],
        resolvedAt: 0,
      },
    };

    await ThreadWorkerService.create(
      { role: "thread", value: binding },
      { emit: () => undefined, requestHost: async () => undefined, flushEvents: async () => undefined },
    );

    expect(mocks.openSession).toHaveBeenCalledWith(sessionFile, join(agentDir, "sessions", "--general--"), cwd);
    expect(mocks.runtimeCreate).toHaveBeenCalledWith(expect.objectContaining({ initialUpdatedAt: 4_000 }));
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
