import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Thread } from "../src/shared/contracts.ts";
import type { MetadataSidecarCommand } from "../src/shared/sidecar-contracts.ts";
import { MetadataWorkerService } from "../src/sidecar/metadata-worker-service.ts";

describe("MetadataWorkerService session tree removal", () => {
  let root: string;
  let service: MetadataWorkerService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "metadata-tree-removal-"));
    ({ service } = await MetadataWorkerService.create({
      role: "metadata",
      value: { agentDir: join(root, "agent"), userDataDir: join(root, "user-data") },
    }));
  });

  afterEach(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("reparents direct children and rewrites fork lineage", async () => {
    const grandparentFile = sessionFile("grandparent");
    const parentFile = sessionFile("parent", grandparentFile);
    const childFile = sessionFile("child", parentFile);
    await register(thread("grandparent"), grandparentFile);
    await register({ ...thread("parent"), parentThreadId: "grandparent" }, parentFile);
    await register({ ...thread("child"), parentThreadId: "parent" }, childFile);

    const result = await service.command(removeCommand("parent", "reparent"));

    expect(result).toEqual({
      removedThreadIds: ["parent"],
      reparentedThreads: [expect.objectContaining({ id: "child", parentThreadId: "grandparent" })],
    });
    expect(existsSync(parentFile)).toBe(false);
    expect(JSON.parse(readFileSync(childFile, "utf8").split("\n", 1)[0]!).parentSession).toBe(grandparentFile);
  });

  it("recovers a pre-commit tombstone after metadata worker restart", async () => {
    await service.dispose();
    const parentFile = sessionFile("parent");
    const tombstonePath = `${parentFile}.crash.deleted`;
    renameSync(parentFile, tombstonePath);
    const journalDir = join(root, "user-data", "session-removal-journals");
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, "crash.json"),
      `${JSON.stringify({
        plan: {
          projectId: "project",
          cwd: root,
          removedSessions: [{ id: "parent", path: parentFile }],
          reparentedSessions: [],
          result: { removedThreadIds: ["parent"], reparentedThreads: [] },
        },
        removals: [{ path: parentFile, tombstonePath }],
        rewrites: [],
      })}\n`,
    );

    ({ service } = await MetadataWorkerService.create({
      role: "metadata",
      value: { agentDir: join(root, "agent"), userDataDir: join(root, "user-data") },
    }));

    expect(existsSync(parentFile)).toBe(true);
    expect(existsSync(tombstonePath)).toBe(false);
  });

  it("cleans staged rewrites when a later child header is invalid", async () => {
    const parentFile = sessionFile("parent");
    const validChildFile = sessionFile("valid-child", parentFile);
    const invalidChildFile = join(root, "invalid-child.jsonl");
    writeFileSync(invalidChildFile, "not-json\n");
    await register(thread("parent"), parentFile);
    await register({ ...thread("valid-child"), parentThreadId: "parent" }, validChildFile);
    await register({ ...thread("invalid-child"), parentThreadId: "parent" }, invalidChildFile);

    await expect(service.command(removeCommand("parent", "reparent"))).rejects.toThrow("invalid Pi session header");

    expect(existsSync(parentFile)).toBe(true);
    expect(readdirSync(root).some((name) => name.endsWith(".reparent"))).toBe(false);
  });

  it("rejects an unknown removal policy at the sidecar boundary", async () => {
    const parentFile = sessionFile("parent");
    await register(thread("parent"), parentFile);
    const command = { ...removeCommand("parent", "subtree"), policy: "invalid" };

    await expect(service.command(command as MetadataSidecarCommand)).rejects.toThrow("Invalid session removal policy");
    expect(existsSync(parentFile)).toBe(true);
  });

  it("deletes every session file in a subtree", async () => {
    const parentFile = sessionFile("parent");
    const childFile = sessionFile("child");
    const grandchildFile = sessionFile("grandchild");
    const otherFile = sessionFile("other");
    await register(thread("parent"), parentFile);
    await register({ ...thread("child"), parentThreadId: "parent" }, childFile);
    await register({ ...thread("grandchild"), parentThreadId: "child" }, grandchildFile);
    await register(thread("other"), otherFile);

    const result = await service.command(removeCommand("parent", "subtree"));

    expect(new Set((result as { removedThreadIds: string[] }).removedThreadIds)).toEqual(
      new Set(["parent", "child", "grandchild"]),
    );
    expect([parentFile, childFile, grandchildFile].every((file) => !existsSync(file))).toBe(true);
    expect(existsSync(otherFile)).toBe(true);
  });

  function sessionFile(id: string, parentSession?: string): string {
    const path = join(root, `${id}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: root,
        ...(parentSession ? { parentSession } : {}),
      })}\n`,
    );
    return path;
  }

  function register(value: Thread, path: string): Promise<unknown> {
    return service.command({
      type: "registerExternalSession",
      projectId: "project",
      cwd: root,
      sessionFile: path,
      thread: value,
    });
  }

  function removeCommand(threadId: string, policy: "subtree" | "reparent"): MetadataSidecarCommand {
    return {
      type: "removeColdSession",
      projectId: "project",
      cwd: root,
      threadId,
      policy,
      lease: {
        projectId: "project",
        threadId,
        operation: "remove",
        nonce: `${threadId}-${policy}`,
        expiresAt: Date.now() + 30_000,
      },
    };
  }
});

function thread(id: string): Thread {
  return {
    id,
    projectId: "project",
    title: id,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    preview: "",
    archived: false,
    running: false,
  };
}
