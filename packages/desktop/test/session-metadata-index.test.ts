import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_WORKSPACE_ID, type Thread } from "../src/shared/contracts.ts";

const mocks = vi.hoisted(() => ({
  listAllSessions: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list: mocks.listSessions, listAll: mocks.listAllSessions },
}));

import { SessionMetadataIndex } from "../src/sidecar/session-metadata-index.ts";

describe("SessionMetadataIndex", () => {
  let userDataDir: string;
  let cwd: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "session-metadata-index-"));
    cwd = join(userDataDir, "project");
    mocks.listAllSessions.mockReset();
    mocks.listAllSessions.mockResolvedValue([]);
    mocks.listSessions.mockReset();
    mocks.listSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("uses a short fixed session directory for the general workspace", async () => {
    const agentDir = join(userDataDir, "agent");
    const sessionDirectory = join(agentDir, "sessions", "--general--");

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([]);

    expect(mocks.listSessions).toHaveBeenCalledWith(cwd, sessionDirectory);
  });

  it("listWithPaths 保留 session.jsonl 绝对路径，list 不暴露", async () => {
    const sessionFile = join(userDataDir, "agent", "sessions", "--general--", "a.jsonl");
    mkdirSync(join(userDataDir, "agent", "sessions", "--general--"), { recursive: true });
    writeFileSync(sessionFile, '{"type":"session","id":"a"}\n');
    mocks.listSessions.mockResolvedValue([sessionInfo("a", sessionFile, "Alpha", 2)]);
    const index = new SessionMetadataIndex(userDataDir, join(userDataDir, "agent"));

    await expect(index.listWithPaths(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([
      expect.objectContaining({ id: "a", title: "Alpha", path: sessionFile }),
    ]);
    await expect(index.list(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([
      expect.not.objectContaining({ path: sessionFile }),
    ]);
  });

  it("skips a session file removed after directory scanning", async () => {
    const removedFile = join(userDataDir, "removed.jsonl");
    mocks.listSessions.mockResolvedValue([sessionInfo("removed", removedFile, "Removed", 2)]);

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([]);
  });

  it("migrates legacy general sessions before indexing the short directory", async () => {
    const agentDir = join(userDataDir, "agent");
    const legacyName = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const legacyDirectory = join(agentDir, "sessions", legacyName);
    const sessionDirectory = join(agentDir, "sessions", "--general--");
    const legacyFile = join(legacyDirectory, "legacy.jsonl");
    const legacyBranchFile = join(legacyDirectory, "branch.jsonl");
    const migratedFile = join(sessionDirectory, "legacy.jsonl");
    const migratedBranchFile = join(sessionDirectory, "branch.jsonl");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(legacyFile, '{"type":"session","id":"legacy"}\n');
    writeFileSync(
      legacyBranchFile,
      `${JSON.stringify({ type: "session", id: "branch", parentSession: legacyFile })}\n`,
    );
    mocks.listSessions.mockImplementation(async (_cwd: string, requestedDirectory?: string) =>
      requestedDirectory === sessionDirectory ? [sessionInfo("legacy", migratedFile, "Legacy", 2)] : [],
    );

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([
      expect.objectContaining({ id: "legacy", title: "Legacy" }),
    ]);

    expect(existsSync(legacyDirectory)).toBe(false);
    expect(existsSync(migratedFile)).toBe(true);
    const migratedBranchHeader = JSON.parse(readFileSync(migratedBranchFile, "utf8"));
    expect(migratedBranchHeader.parentSession).toBe(migratedFile);
    expect(mocks.listSessions).toHaveBeenCalledWith(cwd, sessionDirectory);
  });

  it("re-backfills nested sessions when migrating a persisted general workspace index", async () => {
    const agentDir = join(userDataDir, "agent");
    const legacyName = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const legacyDirectory = join(agentDir, "sessions", legacyName);
    const sessionDirectory = join(agentDir, "sessions", "--general--");
    const parentFile = join(legacyDirectory, "parent.jsonl");
    const childDirectory = join(legacyDirectory, "parent", "abcdef12", "run-0");
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(parentFile, '{"type":"session","id":"parent"}\n');
    writeFileSync(join(childDirectory, "session.jsonl"), '{"type":"session","id":"child"}\n');
    writeFileSync(
      join(userDataDir, "session-metadata-index.json"),
      `${JSON.stringify({
        version: 5,
        projects: {
          [GENERAL_WORKSPACE_ID]: {
            cwd,
            sessionDirectory: legacyDirectory,
            directoryFingerprint: "stale",
            backfillComplete: true,
            explicitSessions: [
              {
                session: {
                  id: "child",
                  projectId: GENERAL_WORKSPACE_ID,
                  title: "Child",
                  createdAt: 1,
                  updatedAt: 3,
                  messageCount: 0,
                  preview: "",
                  archived: false,
                  running: false,
                  parentThreadId: "parent",
                  origin: "subagent",
                  agentName: "reviewer",
                  path: join(childDirectory, "session.jsonl"),
                },
              },
            ],
            sessions: [],
          },
        },
      })}\n`,
    );
    const migratedParentFile = join(sessionDirectory, "parent.jsonl");
    const migratedChildDirectory = join(sessionDirectory, "parent", "abcdef12", "run-0");
    const migratedChildFile = join(migratedChildDirectory, "session.jsonl");
    mocks.listSessions.mockResolvedValue([sessionInfo("parent", migratedParentFile, "Parent", 2)]);
    mocks.listAllSessions.mockImplementation(async (requestedDirectory: string) =>
      requestedDirectory === migratedChildDirectory ? [sessionInfo("child", migratedChildFile, "Child", 3)] : [],
    );

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([
      expect.objectContaining({
        id: "child",
        parentThreadId: "parent",
        origin: "subagent",
        agentName: "reviewer",
      }),
      expect.objectContaining({ id: "parent" }),
    ]);

    expect(mocks.listAllSessions).toHaveBeenCalledWith(migratedChildDirectory);
  });

  it("serves a validated persisted index without scanning session files again", async () => {
    const sessionFile = join(userDataDir, "thread.jsonl");
    writeFileSync(sessionFile, "initial\n");
    const index = new SessionMetadataIndex(userDataDir);
    index.upsert("project", cwd, sessionFile, thread("thread", "Initial"));
    mocks.listSessions.mockResolvedValue([sessionInfo("thread", sessionFile, "Initial", 2)]);
    await expect(index.list("project", cwd)).resolves.toEqual([thread("thread", "Initial")]);
    mocks.listSessions.mockClear();

    const restarted = new SessionMetadataIndex(userDataDir);
    await expect(restarted.list("project", cwd)).resolves.toEqual([thread("thread", "Initial")]);
    await expect(restarted.resolve("project", cwd, "thread")).resolves.toEqual({ id: "thread", path: sessionFile });
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it("rejects persisted preview fields with invalid types and rebuilds them", async () => {
    const sessionFile = join(userDataDir, "thread.jsonl");
    writeFileSync(sessionFile, '{"type":"session","id":"thread"}\n');
    mocks.listSessions.mockResolvedValue([sessionInfo("thread", sessionFile, "Initial", 2)]);
    await new SessionMetadataIndex(userDataDir).list("project", cwd);

    const indexPath = join(userDataDir, "session-metadata-index.json");
    const stored = JSON.parse(readFileSync(indexPath, "utf8")) as {
      projects: Record<string, { sessions: Array<Record<string, unknown>> }>;
    };
    stored.projects.project!.sessions[0]!.lastAssistantPreview = 42;
    writeFileSync(indexPath, `${JSON.stringify(stored, null, 2)}\n`);
    mocks.listSessions.mockClear();

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "thread", lastAssistantPreview: "" }),
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("validates a newly discovered session directory before reusing its persisted index", async () => {
    const sessionFile = join(userDataDir, "recovered.jsonl");
    writeFileSync(sessionFile, "recovered\n");
    mocks.listSessions.mockResolvedValue([
      {
        id: "recovered",
        path: sessionFile,
        name: "Recovered",
        firstMessage: "First prompt",
        created: new Date(10),
        modified: new Date(20),
        messageCount: 2,
      },
    ]);

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      {
        ...thread("recovered", "Recovered"),
        createdAt: 10,
        updatedAt: 20,
        messageCount: 2,
        preview: "First prompt",
      },
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);

    mocks.listSessions.mockClear();
    const restarted = new SessionMetadataIndex(userDataDir);
    await expect(restarted.resolve("project", cwd, "recovered")).resolves.toEqual({
      id: "recovered",
      path: sessionFile,
    });
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);

    mocks.listSessions.mockClear();
    await expect(new SessionMetadataIndex(userDataDir).resolve("project", cwd, "recovered")).resolves.toEqual({
      id: "recovered",
      path: sessionFile,
    });
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it("refreshes additions, metadata changes, and deletions while the worker remains alive", async () => {
    const initialFile = join(userDataDir, "initial.jsonl");
    const addedFile = join(userDataDir, "added.jsonl");
    writeFileSync(initialFile, "initial\n");
    const index = new SessionMetadataIndex(userDataDir);
    index.upsert("project", cwd, initialFile, thread("initial", "Initial"));
    mocks.listSessions.mockResolvedValue([sessionInfo("initial", initialFile, "Initial", 2)]);
    await index.list("project", cwd);
    mocks.listSessions.mockClear();

    writeFileSync(addedFile, "added\n");
    mocks.listSessions.mockResolvedValue([
      sessionInfo("added", addedFile, "Added", 3),
      sessionInfo("initial", initialFile, "Initial", 2),
    ]);
    await expect(index.list("project", cwd)).resolves.toEqual([
      { ...thread("added", "Added"), updatedAt: 3 },
      { ...thread("initial", "Initial"), updatedAt: 2 },
    ]);

    appendFileSync(initialFile, "renamed\n");
    mocks.listSessions.mockResolvedValue([
      sessionInfo("initial", initialFile, "Renamed externally", 4),
      sessionInfo("added", addedFile, "Added", 3),
    ]);
    await expect(index.list("project", cwd)).resolves.toEqual([
      { ...thread("added", "Added"), updatedAt: 3 },
      { ...thread("initial", "Renamed externally"), updatedAt: 2 },
    ]);

    rmSync(addedFile);
    mocks.listSessions.mockResolvedValue([sessionInfo("initial", initialFile, "Renamed externally", 4)]);
    await expect(index.list("project", cwd)).resolves.toEqual([
      { ...thread("initial", "Renamed externally"), updatedAt: 2 },
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(3);
  });

  it("revalidates a persisted index after external changes made while the worker is stopped", async () => {
    const sessionFile = join(userDataDir, "thread.jsonl");
    writeFileSync(sessionFile, "initial\n");
    const index = new SessionMetadataIndex(userDataDir);
    index.upsert("project", cwd, sessionFile, thread("thread", "Initial"));
    mocks.listSessions.mockResolvedValue([sessionInfo("thread", sessionFile, "Initial", 2)]);
    await index.list("project", cwd);
    mocks.listSessions.mockClear();

    appendFileSync(sessionFile, "renamed\n");
    mocks.listSessions.mockResolvedValue([sessionInfo("thread", sessionFile, "Renamed externally", 5)]);

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      { ...thread("thread", "Renamed externally"), updatedAt: 2 },
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("rebuilds once when resolve misses an otherwise fresh cached project", async () => {
    const initialFile = join(userDataDir, "initial.jsonl");
    const recoveredFile = join(userDataDir, "recovered.jsonl");
    writeFileSync(initialFile, "initial\n");
    writeFileSync(recoveredFile, "recovered\n");
    const index = new SessionMetadataIndex(userDataDir);
    index.upsert("project", cwd, initialFile, thread("initial", "Initial"));
    mocks.listSessions.mockResolvedValue([sessionInfo("initial", initialFile, "Initial", 2)]);
    await index.list("project", cwd);
    mocks.listSessions.mockClear();
    mocks.listSessions.mockResolvedValue([
      sessionInfo("initial", initialFile, "Initial", 2),
      sessionInfo("recovered", recoveredFile, "Recovered", 3),
    ]);

    await expect(index.resolve("project", cwd, "recovered")).resolves.toEqual({
      id: "recovered",
      path: recoveredFile,
    });
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("reads a visible message whose JSONL line is larger than the initial tail block", async () => {
    const sessionFile = join(userDataDir, "large-message.jsonl");
    const text = `large assistant preview ${"x".repeat(300 * 1024)}`;
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "large" })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 },
      })}\n`,
    );
    mocks.listSessions.mockResolvedValue([sessionInfo("large", sessionFile, "Large", 2, { messageCount: 1 })]);

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      expect.objectContaining({
        id: "large",
        lastAssistantPreview: text.slice(0, 480),
      }),
    ]);
  });

  it("does not rebuild twice when resolve still misses after refreshing an invalidated project", async () => {
    const sessionFile = join(userDataDir, "initial.jsonl");
    writeFileSync(sessionFile, "initial\n");
    const index = new SessionMetadataIndex(userDataDir);
    index.upsert("project", cwd, sessionFile, thread("initial", "Initial"));
    mocks.listSessions.mockResolvedValue([]);

    await expect(index.resolve("project", cwd, "missing")).rejects.toThrow("Pi session does not exist: missing");
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicitly registered nested session across root rebuilds and metadata worker restarts", async () => {
    const sessionDirectory = join(userDataDir, "sessions");
    const parentFile = join(sessionDirectory, "parent.jsonl");
    const childDirectory = join(sessionDirectory, "parent", "abc12345", "run-0");
    const childFile = join(childDirectory, "session.jsonl");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(parentFile, '{"type":"session","id":"parent"}\n');
    mocks.listSessions.mockResolvedValue([sessionInfo("parent", parentFile, "Parent", 2)]);
    const index = new SessionMetadataIndex(userDataDir);
    await index.list("project", cwd);
    await index.list("project", cwd);
    mocks.listSessions.mockClear();

    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(childFile, '{"type":"session","version":3,"id":"child"}\n');
    index.registerExternalSession("project", cwd, childFile, {
      ...thread("child", "Inspect the renderer tree"),
      preview: "Inspect the renderer tree",
      parentThreadId: "parent",
      origin: "subagent",
      agentName: "reviewer",
    });
    index.upsert("project", cwd, childFile, {
      ...thread("child", "[Read from: plan.md]"),
      preview: "[Read from: plan.md]\n\nInspect the renderer tree",
    });

    await expect(index.resolve("project", cwd, "child")).resolves.toEqual({ id: "child", path: childFile });
    await expect(index.list("project", cwd)).resolves.toContainEqual(
      expect.objectContaining({ id: "child", title: "Inspect the renderer tree" }),
    );
    expect(mocks.listSessions).not.toHaveBeenCalled();

    appendFileSync(parentFile, '{"type":"session_info","name":"Parent renamed"}\n');
    mocks.listSessions.mockResolvedValue([sessionInfo("parent", parentFile, "Parent renamed", 3)]);
    await expect(index.list("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "parent", title: "Parent renamed" }),
      expect.objectContaining({
        id: "child",
        title: "Inspect the renderer tree",
        parentThreadId: "parent",
        origin: "subagent",
        agentName: "reviewer",
      }),
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);

    index.upsert("project", cwd, childFile, {
      ...thread("child", "Renamed child"),
      preview: "[Read from: plan.md]\n\nInspect the renderer tree",
    });
    await expect(index.list("project", cwd)).resolves.toContainEqual(
      expect.objectContaining({ id: "child", title: "Renamed child", agentName: "reviewer" }),
    );

    mocks.listSessions.mockClear();
    const restartedIndex = new SessionMetadataIndex(userDataDir);
    await expect(restartedIndex.resolve("project", cwd, "child")).resolves.toEqual({ id: "child", path: childFile });
    await expect(restartedIndex.list("project", cwd)).resolves.toContainEqual(
      expect.objectContaining({ id: "child", title: "Renamed child", agentName: "reviewer" }),
    );
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });

  it("retries an incomplete nested-session backfill instead of marking it complete", async () => {
    const sessionDirectory = join(userDataDir, "sessions");
    const parentFile = join(sessionDirectory, "parent.jsonl");
    const childDirectory = join(sessionDirectory, "parent", "abc12345", "run-0");
    const childFile = join(childDirectory, "session.jsonl");
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(parentFile, '{"type":"session","id":"parent"}\n');
    writeFileSync(childFile, '{"type":"session","id":"child"}\n');
    let childReadable = false;
    mocks.listSessions.mockResolvedValue([sessionInfo("parent", parentFile, "Parent", 2)]);
    mocks.listAllSessions.mockImplementation(async (requestedDirectory: string) =>
      requestedDirectory === childDirectory && childReadable ? [sessionInfo("child", childFile, "Child", 3)] : [],
    );
    const index = new SessionMetadataIndex(userDataDir);

    await expect(index.list("project", cwd)).resolves.toEqual([expect.objectContaining({ id: "parent" })]);
    childReadable = true;
    mocks.listAllSessions.mockClear();
    mocks.listSessions.mockClear();
    await expect(index.list("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "child", parentThreadId: "parent", origin: "subagent" }),
      expect.objectContaining({ id: "parent" }),
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
    expect(mocks.listAllSessions).toHaveBeenCalledTimes(1);
  });

  it("backfills existing worktree run sessions once when upgrading the metadata index", async () => {
    const sessionDirectory = join(userDataDir, "sessions");
    const parentFile = join(sessionDirectory, "parent.jsonl");
    const childDirectory = join(sessionDirectory, "parent", "abc12345", "run-0");
    const childFile = join(childDirectory, "session.jsonl");
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(parentFile, '{"type":"session","id":"parent"}\n');
    const worktreeCwd = join(userDataDir, "project.worktrees", "review");
    writeFileSync(
      childFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "child",
        timestamp: "1970-01-01T00:00:00.010Z",
        cwd: worktreeCwd,
      })}\n${JSON.stringify({
        type: "message",
        timestamp: "1970-01-01T00:00:00.020Z",
        message: {
          role: "user",
          timestamp: 20,
          content: [
            {
              type: "text",
              text: "Task:\n[Read from: plan.md]\nInspect nested history\n\n## Acceptance Contract",
            },
          ],
        },
      })}\n`,
    );
    mocks.listSessions.mockResolvedValue([sessionInfo("parent", parentFile, "Parent", 2)]);
    mocks.listAllSessions.mockImplementation(async (requestedDirectory: string) =>
      requestedDirectory === childDirectory
        ? [sessionInfo("child", childFile, "", 20, { created: 10, firstMessage: "[Read from: plan.md]" })]
        : [],
    );

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      expect.objectContaining({
        id: "child",
        title: "Inspect nested history",
        parentThreadId: "parent",
        origin: "subagent",
      }),
      expect.objectContaining({ id: "parent" }),
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
    expect(mocks.listAllSessions).toHaveBeenCalledTimes(1);
    expect(mocks.listAllSessions).toHaveBeenCalledWith(childDirectory);

    mocks.listAllSessions.mockClear();
    mocks.listSessions.mockClear();
    mocks.listSessions.mockResolvedValue([sessionInfo("parent", parentFile, "Parent", 2)]);
    await expect(new SessionMetadataIndex(userDataDir).resolve("project", cwd, "child")).resolves.toEqual({
      id: "child",
      path: childFile,
    });
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
    expect(mocks.listSessions).toHaveBeenCalledWith(cwd);
    expect(mocks.listAllSessions).not.toHaveBeenCalled();
  });

  it("trusts projected external session IDs and rejects duplicate IDs at different paths", async () => {
    const sessionFile = join(userDataDir, "child.jsonl");
    const duplicateFile = join(userDataDir, "duplicate.jsonl");
    writeFileSync(sessionFile, '{"type":"session","id":"actual"}\n');
    writeFileSync(duplicateFile, '{"type":"session","id":"actual"}\n');
    const index = new SessionMetadataIndex(userDataDir);
    index.registerExternalSession("project", cwd, sessionFile, thread("projected", "Actual"));
    await expect(index.resolve("project", cwd, "projected")).resolves.toEqual({ id: "projected", path: sessionFile });
    expect(() =>
      index.registerExternalSession("project", cwd, duplicateFile, thread("projected", "Duplicate")),
    ).toThrow("already registered at another path");
    expect(() => index.upsert("project", cwd, duplicateFile, thread("projected", "Duplicate"))).toThrow(
      "already registered at another path",
    );

    mocks.listSessions.mockResolvedValue([sessionInfo("projected", duplicateFile, "Duplicate", 3)]);
    await expect(index.rebuild("project", cwd)).rejects.toThrow("already registered at another path");
  });

  it("indexes forked subagent sessions under their parent with the delegated task title", async () => {
    const parentFile = join(userDataDir, "parent.jsonl");
    const childFile = join(userDataDir, "child.jsonl");
    writeFileSync(parentFile, '{"type":"session"}\n');
    writeFileSync(
      childFile,
      `${[
        '{"type":"session"}',
        '{"type":"message","timestamp":"1970-01-01T00:00:00.010Z","message":{"role":"user","content":[{"type":"text","text":"你好"}],"timestamp":10}}',
        JSON.stringify({
          type: "message",
          timestamp: "1970-01-01T00:00:00.110Z",
          message: {
            role: "user",
            timestamp: 110,
            content: [
              {
                type: "text",
                text: [
                  "You are a delegated subagent running from a fork of the parent session.",
                  "",
                  "Task:",
                  "Implement the Desktop session tree without widening scope.",
                  "",
                  "## Acceptance Contract",
                ].join("\n"),
              },
            ],
          },
        }),
      ].join("\n")}\n`,
    );
    mocks.listSessions.mockResolvedValue([
      sessionInfo("child", childFile, "", 120, {
        created: 100,
        parentSessionPath: parentFile,
        firstMessage: "你好",
      }),
      sessionInfo("parent", parentFile, "你好", 90),
    ]);

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      {
        ...thread("child", "Implement the Desktop session tree without widen"),
        createdAt: 100,
        updatedAt: 120,
        preview: "Implement the Desktop session tree without widen",
        lastUserPreview: "You are a delegated subagent running from a fork of the parent session.\n",
        parentThreadId: "parent",
        origin: "subagent",
      },
      { ...thread("parent", "你好"), updatedAt: 90 },
    ]);
  });

  it("does not reuse an inherited parent title before a fork receives its own prompt", async () => {
    const parentFile = join(userDataDir, "parent.jsonl");
    const childFile = join(userDataDir, "child.jsonl");
    writeFileSync(parentFile, '{"type":"session"}\n');
    writeFileSync(childFile, '{"type":"session"}\n');
    mocks.listSessions.mockResolvedValue([
      sessionInfo("child", childFile, "父会话名称", 20, { created: 10, parentSessionPath: parentFile }),
      sessionInfo("parent", parentFile, "父会话名称", 5),
    ]);

    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([
      {
        ...thread("child", "分支会话"),
        createdAt: 10,
        updatedAt: 20,
        preview: "分支会话",
        parentThreadId: "parent",
        origin: "branch",
      },
      { ...thread("parent", "父会话名称"), updatedAt: 5 },
    ]);
  });

  it("recovers a corrupt index and persists incremental mutations", async () => {
    writeFileSync(join(userDataDir, "session-metadata-index.json"), "not-json");
    const index = new SessionMetadataIndex(userDataDir);
    await expect(index.list("project", cwd)).resolves.toEqual([]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);

    const sessionFile = join(userDataDir, "thread.jsonl");
    writeFileSync(sessionFile, "initial\n");
    index.upsert("project", cwd, sessionFile, thread("thread", "Initial"));
    index.rename("project", cwd, "thread", "Renamed");
    const stored = JSON.parse(readFileSync(join(userDataDir, "session-metadata-index.json"), "utf8")) as {
      projects: Record<string, { sessions: Thread[] }>;
    };
    expect(stored.projects.project?.sessions).toContainEqual(
      expect.objectContaining({ id: "thread", title: "Renamed", updatedAt: 2 }),
    );
    mocks.listSessions.mockResolvedValue([sessionInfo("thread", sessionFile, "Renamed", 3)]);
    await expect(index.list("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "thread", title: "Renamed" }),
    ]);

    rmSync(sessionFile);
    index.remove("project", "thread");
    mocks.listSessions.mockResolvedValue([]);
    await expect(index.list("project", cwd)).resolves.toEqual([]);
    index.invalidateProject("project");

    mocks.listSessions.mockClear();
    await expect(new SessionMetadataIndex(userDataDir).list("project", cwd)).resolves.toEqual([]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });
});

function thread(id: string, title: string): Thread {
  return {
    id,
    projectId: "project",
    title,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    preview: "",
    lastAssistantPreview: "",
    archived: false,
    running: false,
  };
}

function sessionInfo(
  id: string,
  path: string,
  name: string,
  modified: number,
  options: { created?: number; parentSessionPath?: string; firstMessage?: string; messageCount?: number } = {},
) {
  return {
    id,
    path,
    name,
    firstMessage: options.firstMessage ?? "",
    created: new Date(options.created ?? 1),
    modified: new Date(modified),
    messageCount: options.messageCount ?? 0,
    ...(options.parentSessionPath ? { parentSessionPath: options.parentSessionPath } : {}),
  };
}
