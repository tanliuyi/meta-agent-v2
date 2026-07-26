import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../src/shared/contracts.ts";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list: mocks.listSessions },
}));

import { SessionMetadataIndex } from "../src/sidecar/session-metadata-index.ts";

describe("SessionMetadataIndex", () => {
  let userDataDir: string;
  let cwd: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "session-metadata-index-"));
    cwd = join(userDataDir, "project");
    mocks.listSessions.mockReset();
    mocks.listSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
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
      { ...thread("initial", "Renamed externally"), updatedAt: 4 },
      { ...thread("added", "Added"), updatedAt: 3 },
    ]);

    rmSync(addedFile);
    mocks.listSessions.mockResolvedValue([sessionInfo("initial", initialFile, "Renamed externally", 4)]);
    await expect(index.list("project", cwd)).resolves.toEqual([
      { ...thread("initial", "Renamed externally"), updatedAt: 4 },
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
      { ...thread("thread", "Renamed externally"), updatedAt: 5 },
    ]);
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("rebuilds once when resolve misses an otherwise fresh cached project", async () => {
    const initialFile = join(userDataDir, "initial.jsonl");
    const recoveredFile = join(userDataDir, "recovered.jsonl");
    writeFileSync(initialFile, "initial\n");
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

  it("does not rebuild twice when resolve still misses after refreshing an invalidated project", async () => {
    const sessionFile = join(userDataDir, "initial.jsonl");
    writeFileSync(sessionFile, "initial\n");
    const index = new SessionMetadataIndex(userDataDir);
    index.upsert("project", cwd, sessionFile, thread("initial", "Initial"));
    mocks.listSessions.mockResolvedValue([]);

    await expect(index.resolve("project", cwd, "missing")).rejects.toThrow("Pi session does not exist: missing");
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
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
    archived: false,
    running: false,
  };
}

function sessionInfo(
  id: string,
  path: string,
  name: string,
  modified: number,
  options: { created?: number; parentSessionPath?: string; firstMessage?: string } = {},
) {
  return {
    id,
    path,
    name,
    firstMessage: options.firstMessage ?? "",
    created: new Date(options.created ?? 1),
    modified: new Date(modified),
    messageCount: 0,
    ...(options.parentSessionPath ? { parentSessionPath: options.parentSessionPath } : {}),
  };
}
