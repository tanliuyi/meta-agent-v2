import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Thread } from "../shared/contracts.ts";

const INDEX_VERSION = 3;
const INDEX_FILE_NAME = "session-metadata-index.json";

interface IndexedSession extends Thread {
  path: string;
}

interface IndexedProject {
  cwd: string;
  sessionDirectory: string | null;
  directoryFingerprint: string | null;
  sessions: IndexedSession[];
}

interface StoredIndex {
  version: typeof INDEX_VERSION;
  projects: Record<string, IndexedProject>;
}

export class SessionMetadataIndex {
  private readonly path: string;
  private data?: StoredIndex;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, INDEX_FILE_NAME);
  }

  async list(projectId: string, cwd: string): Promise<Thread[]> {
    const project = await this.requireProject(projectId, cwd);
    return project.sessions.map(({ path: _path, ...thread }) => ({ ...thread, running: false }));
  }

  async resolve(projectId: string, cwd: string, threadId: string): Promise<{ id: string; path: string }> {
    const cached = this.load().projects[projectId];
    const cacheWasFresh = this.isProjectFresh(cached, cwd);
    let project = cacheWasFresh ? cached : await this.rebuild(projectId, cwd);
    let session = project.sessions.find(({ id }) => id === threadId);
    if (!session && cacheWasFresh) {
      project = await this.rebuild(projectId, cwd);
      session = project.sessions.find(({ id }) => id === threadId);
    }
    if (!session) throw new Error(`Pi session does not exist: ${threadId}`);
    return { id: session.id, path: session.path };
  }

  upsert(projectId: string, cwd: string, sessionFile: string, thread: Thread): void {
    const data = this.load();
    const project = data.projects[projectId];
    const sessions = project?.cwd === cwd ? [...project.sessions] : [];
    const index = sessions.findIndex(({ id }) => id === thread.id);
    const existing = index === -1 ? undefined : sessions[index];
    const parentThreadId = thread.parentThreadId ?? existing?.parentThreadId;
    const origin = thread.origin ?? existing?.origin;
    const next: IndexedSession = {
      ...thread,
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(origin ? { origin } : {}),
      running: false,
      path: sessionFile,
    };
    if (index === -1) sessions.push(next);
    else sessions[index] = next;
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    data.projects[projectId] = {
      cwd,
      sessionDirectory: dirname(sessionFile),
      directoryFingerprint: null,
      sessions,
    };
    this.persist();
  }

  rename(projectId: string, cwd: string, threadId: string, title: string): void {
    const data = this.load();
    const project = data.projects[projectId];
    if (!project || project.cwd !== cwd) throw new Error(`Session metadata index is missing project ${projectId}`);
    const session = project.sessions.find(({ id }) => id === threadId);
    if (!session) throw new Error(`Pi session does not exist: ${threadId}`);
    session.title = title;
    session.updatedAt = Date.now();
    project.directoryFingerprint = null;
    this.persist();
  }

  remove(projectId: string, threadId: string): void {
    const data = this.load();
    const project = data.projects[projectId];
    if (!project) return;
    project.sessions = project.sessions.filter(({ id }) => id !== threadId);
    project.directoryFingerprint = null;
    this.persist();
  }

  invalidateProject(projectId: string): void {
    const data = this.load();
    if (!Object.hasOwn(data.projects, projectId)) return;
    delete data.projects[projectId];
    this.persist();
  }

  async rebuild(projectId: string, cwd: string): Promise<IndexedProject> {
    const data = this.load();
    const current = data.projects[projectId];
    const knownDirectory = current?.cwd === cwd ? current.sessionDirectory : null;
    const fingerprintBeforeScan = fingerprintSessionDirectory(knownDirectory);
    const listedSessions = await SessionManager.list(cwd);
    const threadIdByPath = new Map(listedSessions.map((session) => [resolve(session.path), session.id]));
    const sessions = await Promise.all(
      listedSessions.map(async (session): Promise<IndexedSession> => {
        const parentThreadId = session.parentSessionPath
          ? threadIdByPath.get(resolve(session.parentSessionPath))
          : undefined;
        const fork = parentThreadId ? await readForkDescriptor(session) : undefined;
        return {
          id: session.id,
          projectId,
          title: fork?.title || session.name || session.firstMessage || "新会话",
          createdAt: session.created.getTime(),
          updatedAt: session.modified.getTime(),
          messageCount: session.messageCount,
          preview: fork?.title || session.firstMessage,
          archived: false,
          running: false,
          ...(parentThreadId ? { parentThreadId } : {}),
          ...(fork?.origin ? { origin: fork.origin } : {}),
          path: session.path,
        };
      }),
    );
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    const sessionDirectory = knownDirectory ?? (sessions[0] ? dirname(sessions[0].path) : null);
    const project = {
      cwd,
      sessionDirectory,
      directoryFingerprint: fingerprintBeforeScan,
      sessions,
    };
    data.projects[projectId] = project;
    this.persist();
    return project;
  }

  private async requireProject(projectId: string, cwd: string): Promise<IndexedProject> {
    const project = this.load().projects[projectId];
    if (this.isProjectFresh(project, cwd)) return project;
    return this.rebuild(projectId, cwd);
  }

  private isProjectFresh(project: IndexedProject | undefined, cwd: string): project is IndexedProject {
    return (
      project?.cwd === cwd &&
      project.directoryFingerprint !== null &&
      fingerprintSessionDirectory(project.sessionDirectory) === project.directoryFingerprint
    );
  }

  private load(): StoredIndex {
    if (this.data) return this.data;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (isStoredIndex(parsed)) {
        this.data = parsed;
        return parsed;
      }
    } catch {
      // Missing and corrupt indexes are rebuilt lazily per project.
    }
    this.data = { version: INDEX_VERSION, projects: {} };
    return this.data;
  }

  private persist(): void {
    const data = this.load();
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, this.path);
  }
}

function isStoredIndex(value: unknown): value is StoredIndex {
  if (!isRecord(value) || value.version !== INDEX_VERSION || !isRecord(value.projects)) return false;
  return Object.values(value.projects).every(
    (project) =>
      isRecord(project) &&
      typeof project.cwd === "string" &&
      (typeof project.sessionDirectory === "string" || project.sessionDirectory === null) &&
      (typeof project.directoryFingerprint === "string" || project.directoryFingerprint === null) &&
      Array.isArray(project.sessions) &&
      project.sessions.every(isIndexedSession),
  );
}

function isIndexedSession(value: unknown): value is IndexedSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    typeof value.title === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    typeof value.messageCount === "number" &&
    typeof value.preview === "string" &&
    typeof value.archived === "boolean" &&
    typeof value.running === "boolean" &&
    (value.parentThreadId === undefined || typeof value.parentThreadId === "string") &&
    (value.origin === undefined || value.origin === "branch" || value.origin === "subagent") &&
    typeof value.path === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ForkDescriptor {
  title: string;
  prompt?: string;
  origin: "branch" | "subagent";
}

async function readForkDescriptor(session: SessionInfo): Promise<ForkDescriptor> {
  const activity = await readForkActivity(session.path, session.created.getTime());
  const origin = activity.prompt?.includes("You are a delegated subagent running from a fork of the parent session.")
    ? "subagent"
    : "branch";
  return {
    origin,
    title: activity.name || (activity.prompt ? forkTitle(activity.prompt, origin) : "分支会话"),
    ...(activity.prompt ? { prompt: activity.prompt } : {}),
  };
}

async function readForkActivity(
  sessionFile: string,
  createdAt: number,
): Promise<{ prompt?: string; name?: string | null }> {
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  let prompt: string | undefined;
  let name: string | null | undefined;
  for await (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const entryTime = typeof value.timestamp === "string" ? new Date(value.timestamp).getTime() : Number.NaN;
    if (!Number.isFinite(entryTime) || entryTime < createdAt) continue;
    if (value.type === "session_info") {
      name = typeof value.name === "string" ? value.name.trim() || null : null;
      continue;
    }
    if (prompt || value.type !== "message" || !isRecord(value.message) || value.message.role !== "user") continue;
    const messageTime = typeof value.message.timestamp === "number" ? value.message.timestamp : entryTime;
    if (messageTime < createdAt) continue;
    const text = messageText(value.message.content).trim();
    if (text) prompt = text;
  }
  return { ...(prompt ? { prompt } : {}), ...(name !== undefined ? { name } : {}) };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join(" ");
}

function forkTitle(prompt: string, origin: ForkDescriptor["origin"]): string {
  if (origin === "subagent") {
    const task = /(?:^|\n)Task:\n([\s\S]*?)(?:\n\n## Acceptance Contract|\n\n## |$)/.exec(prompt)?.[1];
    const taskLine = task
      ?.split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (taskLine) return truncateTitle(taskLine);
  }
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("[Read from:"));
  return truncateTitle(firstLine ?? "分支会话");
}

function truncateTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 48) || "分支会话";
}

function fingerprintSessionDirectory(directory: string | null): string | null {
  if (directory === null) return null;
  try {
    const entries = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    const hash = createHash("sha256");
    for (const name of entries) {
      const stats = statSync(join(directory, name), { bigint: true });
      hash.update(name);
      hash.update("\0");
      hash.update(stats.dev.toString());
      hash.update("\0");
      hash.update(stats.ino.toString());
      hash.update("\0");
      hash.update(stats.size.toString());
      hash.update("\0");
      hash.update(stats.mtimeNs.toString());
      hash.update("\0");
      hash.update(stats.ctimeNs.toString());
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}
