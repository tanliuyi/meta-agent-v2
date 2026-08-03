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
import { GENERAL_WORKSPACE_ID, type Thread } from "../src/shared/contracts.ts";
import type { MetadataSidecarCommand } from "../src/shared/sidecar-contracts.ts";
import { resolveDesktopSessionDirectory } from "../src/sidecar/desktop-session-directory.ts";
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

  it("promotes a child session to root by clearing its parentSession header", async () => {
    const parentFile = sessionFile("parent");
    const childFile = sessionFile("child", parentFile);
    const grandchildFile = sessionFile("grandchild", childFile);
    await register(thread("parent"), parentFile);
    await register(
      { ...thread("child"), parentThreadId: "parent", origin: "subagent", agentName: "reviewer" },
      childFile,
    );
    await register({ ...thread("grandchild"), parentThreadId: "child" }, grandchildFile);

    const result = await service.command(promoteCommand("child"));

    expect(result).toEqual({
      removedThreadIds: [],
      reparentedThreads: [expect.objectContaining({ id: "child" })],
    });
    const promoted = (result as { reparentedThreads: Thread[] }).reparentedThreads[0]!;
    expect(promoted).not.toHaveProperty("parentThreadId");
    expect(promoted).not.toHaveProperty("origin");
    expect(promoted).not.toHaveProperty("agentName");
    expect([parentFile, childFile, grandchildFile].every((file) => existsSync(file))).toBe(true);
    expect(JSON.parse(readFileSync(childFile, "utf8").split("\n", 1)[0]!)).toMatchObject({
      promotedRoot: true,
    });
    expect(JSON.parse(readFileSync(childFile, "utf8").split("\n", 1)[0]!)).not.toHaveProperty("parentSession");
    expect(JSON.parse(readFileSync(grandchildFile, "utf8").split("\n", 1)[0]!).parentSession).toBe(childFile);
    const listed = (await service.command({ type: "listSessions", projectId: "project", cwd: root })) as Thread[];
    const listedChild = listed.find(({ id }) => id === "child")!;
    expect(listedChild).not.toHaveProperty("parentThreadId");
    expect(listedChild).not.toHaveProperty("origin");
    expect(listedChild).not.toHaveProperty("agentName");
  });

  it("keeps a promoted session root after the metadata index is lost and rebuilt", async () => {
    const projectId = GENERAL_WORKSPACE_ID;
    const sessionDirectory = resolveDesktopSessionDirectory(projectId, join(root, "agent"))!;
    const parentId = "abcd1234";
    const childId = "c0ffee01";
    const grandchildId = "b00b1e55";
    const parentFile = join(sessionDirectory, `${parentId}.jsonl`);
    const childDirectory = join(sessionDirectory, parentId, "a11ce001", "run-1");
    const grandchildDirectory = join(sessionDirectory, childId, "a11ce002", "run-1");
    const childFile = join(childDirectory, "session.jsonl");
    const grandchildFile = join(grandchildDirectory, "session.jsonl");
    mkdirSync(childDirectory, { recursive: true });
    mkdirSync(grandchildDirectory, { recursive: true });
    writeSessionHeader(parentFile, parentId);
    writeSessionHeader(childFile, childId, parentFile);
    writeSessionHeader(grandchildFile, grandchildId, childFile);
    await registerExternal(projectId, thread(parentId), parentFile);
    await registerExternal(projectId, { ...thread(childId), parentThreadId: parentId }, childFile);
    await registerExternal(projectId, { ...thread(grandchildId), parentThreadId: childId }, grandchildFile);

    await service.command(promoteCommand(childId, projectId));

    // 磁盘 header 是持久化真相：索引丢失后重建仍保持根身份。
    await service.dispose();
    rmSync(join(root, "user-data", "session-metadata-index.json"), { force: true });
    ({ service } = await MetadataWorkerService.create({
      role: "metadata",
      value: { agentDir: join(root, "agent"), userDataDir: join(root, "user-data") },
    }));

    const listed = (await service.command({
      type: "listSessions",
      projectId,
      cwd: root,
    })) as Thread[];
    expect(listed.find(({ id }) => id === childId)).not.toHaveProperty("parentThreadId");
    expect(listed.find(({ id }) => id === grandchildId)?.parentThreadId).toBe(childId);
    expect(listed.find(({ id }) => id === parentId)?.parentThreadId).toBeUndefined();
  });

  it("rejects promoting a root session", async () => {
    const parentFile = sessionFile("parent");
    await register(thread("parent"), parentFile);

    await expect(service.command(promoteCommand("parent"))).rejects.toThrow("already a root session");
    expect(existsSync(parentFile)).toBe(true);
    expect(JSON.parse(readFileSync(parentFile, "utf8").split("\n", 1)[0]!)).not.toHaveProperty("parentSession");
  });

  it("rejects promoting an unknown session", async () => {
    await expect(service.command(promoteCommand("missing"))).rejects.toThrow("Pi session does not exist");
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
    writeSessionHeader(path, id, parentSession);
    return path;
  }

  function writeSessionHeader(path: string, id: string, parentSession?: string): void {
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
  }

  function register(value: Thread, path: string): Promise<unknown> {
    return registerExternal("project", value, path);
  }

  function registerExternal(projectId: string, value: Thread, path: string): Promise<unknown> {
    return service.command({
      type: "registerExternalSession",
      projectId,
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

  function promoteCommand(threadId: string, projectId = "project"): MetadataSidecarCommand {
    return {
      type: "promoteColdSession",
      projectId,
      cwd: root,
      threadId,
      lease: {
        projectId,
        threadId,
        operation: "promote",
        nonce: `${threadId}-promote`,
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
