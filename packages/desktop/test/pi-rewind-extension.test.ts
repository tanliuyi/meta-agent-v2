import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCheckpoint, git, loadAllCheckpoints } from "../src/main/pi/extensions/pi-rewind/src/core.ts";
import piRewindDesktop, {
  getDesktopCheckpointDiff,
  restoreDesktopCheckpoint,
} from "../src/main/pi/extensions/pi-rewind/src/index.ts";
import { registerRewindController } from "../src/main/pi/extensions/pi-rewind/src/service.ts";
import { createInitialState } from "../src/main/pi/extensions/pi-rewind/src/state.ts";
import type { PiCheckpointNoticeDetails } from "../src/shared/pi-rewind-contracts.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type ExtensionHandler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-pi-rewind-extension-"));
  temporaryDirectories.push(root);
  await git(["init"], root);
  await git(["config", "user.email", "test@example.com"], root);
  await git(["config", "user.name", "Desktop Test"], root);
  await git(["config", "core.autocrlf", "false"], root);
  await writeFile(join(root, "file.txt"), "before\n");
  await git(["add", "file.txt"], root);
  await git(["commit", "-m", "initial"], root);
  return root;
}

describe("pi-rewind Desktop extension", () => {
  it("emits checkpoint details and restores through the Desktop service without registering commands", async () => {
    const root = await createRepository();
    const handlers = new Map<string, ExtensionHandler>();
    const messages: Array<{ customType?: string; details?: unknown }> = [];
    const registerCommand = vi.fn();
    const registerShortcut = vi.fn();
    const api = {
      on(event: string, handler: ExtensionHandler) {
        handlers.set(event, handler);
      },
      sendMessage(message: { customType?: string; details?: unknown }) {
        messages.push(message);
      },
      registerCommand,
      registerShortcut,
    } as unknown as ExtensionAPI;
    const context = {
      cwd: root,
      signal: undefined,
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    piRewindDesktop(api);
    expect(registerCommand).not.toHaveBeenCalled();
    expect(registerShortcut).not.toHaveBeenCalled();

    await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, context);
    await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "Update the file" }, context);
    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 }, context);
    await handlers.get("tool_call")?.(
      { type: "tool_call", toolCallId: "call-1", toolName: "write", input: { path: "file.txt" } },
      context,
    );
    await writeFile(join(root, "file.txt"), "after\n");
    await handlers.get("tool_execution_end")?.(
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "write", isError: false },
      context,
    );
    await handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 1 }, context);
    expect(messages).toHaveLength(0);
    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 2 }, context);
    await handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 2 }, context);
    expect(messages).toHaveLength(0);
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.customType).toBe("pi-rewind.checkpoint");
    const details = messages[0]?.details as PiCheckpointNoticeDetails;
    expect(details).toMatchObject({ reason: "run", fileCount: 1, additions: 1, deletions: 1 });
    expect(details.files).toEqual([expect.objectContaining({ path: "file.txt", additions: 1, deletions: 1 })]);
    const diff = await getDesktopCheckpointDiff(
      root,
      "session-1",
      details.restoreCheckpointId,
      details.checkpointId,
      "file.txt",
    );
    expect(diff.patch).toContain("+after");

    await git(["add", "file.txt"], root);
    await expect(
      restoreDesktopCheckpoint(root, "session-1", details.restoreCheckpointId, details.checkpointId),
    ).rejects.toThrow(/staging changed/i);
    await git(["reset"], root);

    const restored = await restoreDesktopCheckpoint(
      root,
      "session-1",
      details.restoreCheckpointId,
      details.checkpointId,
    );
    expect(restored).toEqual({ checkpointId: details.restoreCheckpointId, restoredFiles: 1 });
    expect((await readFile(join(root, "file.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("before\n");

    await writeFile(join(root, "file.txt"), "manual change\n");
    await expect(
      restoreDesktopCheckpoint(root, "session-1", details.restoreCheckpointId, details.checkpointId),
    ).rejects.toThrow(/changed after this checkpoint/i);

    await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "Run a failing edit" }, context);
    await handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 3 }, context);
    await handlers.get("tool_call")?.(
      { type: "tool_call", toolCallId: "call-failed", toolName: "bash", input: { command: "edit then fail" } },
      context,
    );
    await writeFile(join(root, "file.txt"), "changed before failure\n");
    await handlers.get("tool_execution_end")?.(
      { type: "tool_execution_end", toolCallId: "call-failed", toolName: "bash", isError: true },
      context,
    );
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.customType).toBe("pi-rewind.checkpoint");

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("atomically consumes a recovery marker after a successful recovery", async () => {
    const root = await createRepository();
    const recovery = await createCheckpoint({
      root,
      id: "before-restore-session-recovery-1",
      sessionId: "session-recovery",
      trigger: "before-restore",
      turnIndex: 1,
    });
    await writeFile(join(root, "file.txt"), "interrupted target\n");
    const expected = await createCheckpoint({
      root,
      id: "resume-session-recovery-2",
      sessionId: "session-recovery",
      trigger: "resume",
      turnIndex: 2,
    });
    const state = createInitialState();
    state.gitAvailable = true;
    state.repoRoot = root;
    state.sessionId = "session-recovery";
    state.checkpoints.set(recovery.id, recovery);
    state.checkpoints.set(expected.id, expected);
    state.lastCheckpoint = expected;
    const unregister = registerRewindController(root, "session-recovery", state);

    await expect(restoreDesktopCheckpoint(root, "session-recovery", recovery.id, expected.id)).resolves.toMatchObject({
      checkpointId: recovery.id,
    });
    unregister();

    const checkpoints = await loadAllCheckpoints(root, "session-recovery");
    expect(checkpoints.some((checkpoint) => checkpoint.trigger === "before-restore")).toBe(false);
    expect(checkpoints.some((checkpoint) => checkpoint.id.startsWith("recovered-session-recovery-"))).toBe(true);
    expect(state.lastCheckpoint?.trigger).toBe("resume");
    expect((await readFile(join(root, "file.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("before\n");
  });

  it("prunes repeated resume checkpoints to the retention limit during initialization", async () => {
    const root = await createRepository();
    const seed = await createCheckpoint({
      root,
      id: "resume-session-cap-seed",
      sessionId: "session-cap",
      trigger: "resume",
      turnIndex: 0,
    });
    const refs = Array.from(
      { length: 50 },
      (_, index) => `create refs/pi-checkpoints/resume-session-cap-alias-${index} ${seed.commitSha}`,
    );
    await git(["update-ref", "--stdin"], root, { input: `${refs.join("\n")}\n` });
    expect(await loadAllCheckpoints(root, "session-cap")).toHaveLength(51);

    const handlers = new Map<string, ExtensionHandler>();
    const api = {
      on(event: string, handler: ExtensionHandler) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd: root,
      sessionManager: { getSessionId: () => "session-cap" },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;

    piRewindDesktop(api);
    await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, context);
    await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "Continue" }, context);
    expect(await loadAllCheckpoints(root, "session-cap")).toHaveLength(50);
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  });

  it("degrades without blocking session startup when the Git index is conflicted", async () => {
    const root = await createRepository();
    const baseBranch = await git(["branch", "--show-current"], root);
    await git(["switch", "-c", "conflicting"], root);
    await writeFile(join(root, "file.txt"), "branch\n");
    await git(["commit", "-am", "branch change"], root);
    await git(["switch", baseBranch], root);
    await writeFile(join(root, "file.txt"), "main\n");
    await git(["commit", "-am", "main change"], root);
    await expect(git(["merge", "conflicting"], root)).rejects.toThrow();

    const handlers = new Map<string, ExtensionHandler>();
    const notify = vi.fn();
    const api = {
      on(event: string, handler: ExtensionHandler) {
        handlers.set(event, handler);
      },
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd: root,
      sessionManager: { getSessionId: () => "session-conflict" },
      ui: { notify },
    } as unknown as ExtensionContext;

    piRewindDesktop(api);
    expect(handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, context)).toBeUndefined();
    await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "Continue" }, context);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Checkpoint history is disabled"),
      "warning",
      expect.objectContaining({ customType: "pi-rewind.error" }),
    );
  });
});
