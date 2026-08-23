import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERAL_WORKSPACE_ID, type Thread } from "../src/shared/contracts.ts";
import { SessionMetadataIndex } from "../src/sidecar/session-metadata-index.ts";

describe("SessionMetadataIndex", () => {
  let userDataDir: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "session-metadata-index-"));
    agentDir = join(userDataDir, "agent");
    cwd = join(userDataDir, "project");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("scans system Pi JSONL sessions and keeps paths out of the public thread list", async () => {
    const directory = projectSessionDirectory(agentDir, cwd);
    const sessionFile = writeSession(directory, {
      id: "alpha",
      cwd,
      name: "Alpha",
      messages: [
        { role: "user", text: "First prompt", timestamp: 2 },
        { role: "assistant", text: "Final answer", timestamp: 3 },
      ],
    });
    const index = new SessionMetadataIndex(userDataDir, agentDir);

    await expect(index.list("project", cwd)).resolves.toEqual([
      expect.objectContaining({
        id: "alpha",
        title: "Alpha",
        messageCount: 2,
        preview: "First prompt",
        lastUserPreview: "First prompt",
        lastAssistantPreview: "Final answer",
        updatedAt: 3,
      }),
    ]);
    await expect(index.list("project", cwd)).resolves.toEqual([expect.not.objectContaining({ path: sessionFile })]);
    await expect(index.listWithPaths("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "alpha", path: sessionFile }),
    ]);
  });

  it("groups sessions using the public parentSession header", async () => {
    const directory = projectSessionDirectory(agentDir, cwd);
    const parentSession = writeSession(directory, {
      id: "parent",
      cwd,
      messages: [{ role: "user", text: "Parent prompt", timestamp: 2 }],
    });
    writeSession(directory, {
      id: "child",
      cwd,
      parentSession,
      messages: [{ role: "user", text: "Child prompt", timestamp: 3 }],
    });

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list("project", cwd)).resolves.toContainEqual(
      expect.objectContaining({ id: "child", parentThreadId: "parent", origin: "branch" }),
    );
  });

  it("uses the fixed general-workspace directory and filters sessions by cwd", async () => {
    const directory = join(agentDir, "sessions", "--general--");
    writeSession(directory, {
      id: "matching",
      cwd,
      messages: [{ role: "user", text: "Keep", timestamp: 2 }],
    });
    writeSession(directory, {
      id: "other",
      cwd: join(userDataDir, "other"),
      messages: [{ role: "user", text: "Ignore", timestamp: 3 }],
    });

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([
      expect.objectContaining({ id: "matching" }),
    ]);
  });

  it("migrates the legacy general-workspace directory before scanning", async () => {
    const legacyDirectory = projectSessionDirectory(agentDir, cwd);
    const legacyFile = writeSession(legacyDirectory, {
      id: "legacy",
      cwd,
      name: "Legacy",
      messages: [{ role: "user", text: "Migrated", timestamp: 2 }],
    });
    const targetFile = join(agentDir, "sessions", "--general--", "legacy.jsonl");

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list(GENERAL_WORKSPACE_ID, cwd)).resolves.toEqual([
      expect.objectContaining({ id: "legacy", title: "Legacy" }),
    ]);

    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(targetFile)).toBe(true);
  });

  it("refreshes additions, metadata changes, and deletions from system Pi files", async () => {
    const directory = projectSessionDirectory(agentDir, cwd);
    const initial = writeSession(directory, {
      id: "initial",
      cwd,
      name: "Initial",
      messages: [{ role: "user", text: "Initial prompt", timestamp: 2 }],
    });
    const index = new SessionMetadataIndex(userDataDir, agentDir);
    await expect(index.list("project", cwd)).resolves.toEqual([expect.objectContaining({ id: "initial" })]);
    const restarted = new SessionMetadataIndex(userDataDir, agentDir);

    writeSession(directory, {
      id: "added",
      cwd,
      name: "Added",
      messages: [{ role: "user", text: "Added prompt", timestamp: 4 }],
    });
    await expect(restarted.list("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "added" }),
      expect.objectContaining({ id: "initial" }),
    ]);

    writeSession(directory, {
      id: "initial",
      cwd,
      name: "Renamed externally",
      messages: [{ role: "user", text: "Initial prompt", timestamp: 5 }],
    });
    await expect(restarted.list("project", cwd)).resolves.toContainEqual(
      expect.objectContaining({ id: "initial", title: "Renamed externally" }),
    );

    rmSync(join(directory, "added.jsonl"));
    await expect(restarted.list("project", cwd)).resolves.toEqual([
      expect.objectContaining({ id: "initial", title: "Renamed externally" }),
    ]);
    expect(existsSync(initial)).toBe(true);
  });

  it("rebuilds corrupt persisted indexes from session files", async () => {
    const directory = projectSessionDirectory(agentDir, cwd);
    writeSession(directory, {
      id: "recovered",
      cwd,
      messages: [{ role: "user", text: "Recovered prompt", timestamp: 2 }],
    });
    writeFileSync(join(userDataDir, "session-metadata-index.json"), '{"version":6,"projects":42}\n');

    await expect(new SessionMetadataIndex(userDataDir, agentDir).resolve("project", cwd, "recovered")).resolves.toEqual(
      {
        id: "recovered",
        path: join(directory, "recovered.jsonl"),
        updatedAt: 2,
      },
    );
  });

  it("skips malformed and duplicate session identities", async () => {
    const directory = projectSessionDirectory(agentDir, cwd);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "invalid.jsonl"), '{"type":"session","id":"invalid"}\n');
    writeSession(directory, { id: "duplicate", cwd, fileName: "first.jsonl" });
    writeSession(directory, { id: "duplicate", cwd, fileName: "second.jsonl" });

    const index = new SessionMetadataIndex(userDataDir, agentDir);
    await expect(index.list("project", cwd)).rejects.toThrow("Pi session ID duplicate is already registered");
  });

  it("reads an assistant preview whose JSONL line exceeds the first tail block", async () => {
    const text = `large assistant preview ${"x".repeat(300 * 1024)}`;
    writeSession(projectSessionDirectory(agentDir, cwd), {
      id: "large",
      cwd,
      messages: [
        { role: "user", text: "Prompt", timestamp: 2 },
        { role: "assistant", text, timestamp: 3 },
      ],
    });

    await expect(new SessionMetadataIndex(userDataDir, agentDir).list("project", cwd)).resolves.toEqual([
      expect.objectContaining({
        id: "large",
        lastAssistantPreview: text.slice(0, 480),
      }),
    ]);
  });

  it("keeps explicitly registered external sessions across index restarts", async () => {
    const sessionFile = writeSession(join(userDataDir, "external"), {
      id: "external",
      cwd,
      messages: [{ role: "user", text: "External prompt", timestamp: 2 }],
    });
    const index = new SessionMetadataIndex(userDataDir, agentDir);
    index.registerExternalSession("project", cwd, sessionFile, thread("external", "External"));

    await expect(new SessionMetadataIndex(userDataDir, agentDir).resolve("project", cwd, "external")).resolves.toEqual({
      id: "external",
      path: sessionFile,
      updatedAt: 2,
    });
  });

  it("plans and applies a reparenting removal without touching session files", async () => {
    const directory = join(userDataDir, "external");
    const parentFile = writeSession(directory, { id: "parent", cwd });
    const childFile = writeSession(directory, { id: "child", cwd });
    const grandchildFile = writeSession(directory, { id: "grandchild", cwd });
    const index = new SessionMetadataIndex(userDataDir, agentDir);
    index.registerExternalSession("project", cwd, parentFile, thread("parent", "Parent"));
    index.registerExternalSession("project", cwd, childFile, {
      ...thread("child", "Child"),
      parentThreadId: "parent",
      origin: "branch",
    });
    index.registerExternalSession("project", cwd, grandchildFile, {
      ...thread("grandchild", "Grandchild"),
      parentThreadId: "child",
      origin: "branch",
    });

    const plan = await index.planRemoval("project", cwd, "child", "reparent");
    expect(plan.result).toEqual({
      removedThreadIds: ["child"],
      reparentedThreads: [expect.objectContaining({ id: "grandchild", parentThreadId: "parent" })],
    });
    expect(index.applyRemoval(plan)).toEqual(plan.result);
    expect(index.isRemovalApplied(plan)).toBe(true);
    expect(readFileSync(childFile, "utf8")).toContain('"id":"child"');
  });
});

function projectSessionDirectory(agentDir: string, cwd: string): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

function writeSession(
  directory: string,
  options: {
    id: string;
    cwd: string;
    fileName?: string;
    name?: string;
    parentSession?: string;
    messages?: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp: number;
    }>;
  },
): string {
  mkdirSync(directory, { recursive: true });
  const sessionFile = join(directory, options.fileName ?? `${options.id}.jsonl`);
  const entries: unknown[] = [
    {
      type: "session",
      version: 3,
      id: options.id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: options.cwd,
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    },
  ];
  if (options.name) {
    entries.push({
      type: "session_info",
      id: "info",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.001Z",
      name: options.name,
    });
  }
  for (const [index, message] of (options.messages ?? []).entries()) {
    entries.push({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: new Date(message.timestamp).toISOString(),
      message: {
        role: message.role,
        content: [{ type: "text", text: message.text }],
        timestamp: message.timestamp,
      },
    });
  }
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return sessionFile;
}

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
