import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_WORKSPACE_ID } from "../src/shared/contracts.ts";
import type { ThreadWorkerBinding } from "../src/shared/sidecar-contracts.ts";

const mocks = vi.hoisted(() => ({
  runtimeCreate: vi.fn(),
}));

vi.mock("../src/sidecar/pi-rpc-session-runtime.ts", () => ({
  PiRpcSessionRuntime: { create: mocks.runtimeCreate },
}));

import { resolveDesktopSessionDirectory } from "../src/sidecar/desktop-session-directory.ts";
import { ThreadWorkerService } from "../src/sidecar/thread-worker-service.ts";

const serviceContext = {
  emit: vi.fn(),
  requestHost: vi.fn(async () => undefined),
  flushEvents: vi.fn(async () => undefined),
};

describe("ThreadWorkerService", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "thread-worker-service-"));
    mocks.runtimeCreate.mockReset();
    serviceContext.emit.mockReset();
    serviceContext.requestHost.mockClear();
    serviceContext.flushEvents.mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves ordinary project session directories on the Pi default", () => {
    expect(resolveDesktopSessionDirectory("project", join(root, "agent"))).toBeUndefined();
  });

  it("delegates general workspace creation to the RPC runtime", async () => {
    const cwd = join(root, "workspaces", "general");
    const agentDir = join(root, "agent");
    const sessionId = "general-thread";
    const sessionFile = join(agentDir, "sessions", "--general--", `${sessionId}.jsonl`);
    const bootstrap = { threadId: sessionId };
    mocks.runtimeCreate.mockResolvedValue({
      id: sessionId,
      sessionFile,
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
        model: { provider: "provider", id: "model" },
        thinkingLevel: "off",
      },
    };

    const result = await ThreadWorkerService.create({ role: "thread", value: binding }, serviceContext);

    expect(mocks.runtimeCreate).toHaveBeenCalledWith(expect.objectContaining({ binding }));
    expect(serviceContext.emit).toHaveBeenCalledWith({
      type: "session-materialized",
      projectId: GENERAL_WORKSPACE_ID,
      sessionId,
      sessionFile,
    });
    expect(result.readyResult).toBe(bootstrap);
  });

  it("opens a canonical session path with the original cwd", async () => {
    const cwd = join(root, "workspaces", "general");
    const agentDir = join(root, "agent");
    const sessionId = "general-thread";
    const sessionFile = join(agentDir, "sessions", "--general--", `${sessionId}.jsonl`);
    mkdirSync(join(agentDir, "sessions", "--general--"), { recursive: true });
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
    mocks.runtimeCreate.mockResolvedValue({
      id: sessionId,
      sessionFile,
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
    };

    await ThreadWorkerService.create({ role: "thread", value: binding }, serviceContext);

    expect(mocks.runtimeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ binding: expect.objectContaining({ sessionFile, initialUpdatedAt: 4_000, cwd }) }),
    );
  });

  it("rejects a session identity mismatch before starting Pi", async () => {
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

    const binding: ThreadWorkerBinding = {
      mode: "open",
      projectId: "project",
      cwd,
      agentDir: join(root, "agent"),
      threadId: "requested-thread",
      sessionFile,
    };

    await expect(ThreadWorkerService.create({ role: "thread", value: binding }, serviceContext)).rejects.toThrow(
      "Session identity does not match",
    );
    expect(mocks.runtimeCreate).not.toHaveBeenCalled();
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
  });
});
