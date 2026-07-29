import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Thread } from "../shared/contracts.ts";
import {
  migrateLegacyGeneralSessionDirectory,
  remapLegacyGeneralSessionPath,
  resolveDesktopSessionDirectory,
} from "./desktop-session-directory.ts";

const INDEX_VERSION = 4;
const INDEX_FILE_NAME = "session-metadata-index.json";

export class InvalidExternalSessionError extends Error {
  constructor(sessionFile: string) {
    super(`Invalid external Pi session: ${sessionFile}`);
    this.name = "InvalidExternalSessionError";
  }
}

interface IndexedSession extends Thread {
  path: string;
}

interface ExplicitIndexedSession {
  session: IndexedSession;
  fileFingerprint: string;
}

interface IndexedProject {
  cwd: string;
  sessionDirectory: string | null;
  directoryFingerprint: string | null;
  backfillComplete: boolean;
  explicitSessions: ExplicitIndexedSession[];
  sessions: IndexedSession[];
}

interface StoredIndex {
  version: typeof INDEX_VERSION;
  projects: Record<string, IndexedProject>;
}

export class SessionMetadataIndex {
  private readonly path: string;
  private readonly agentDir: string | undefined;
  private data?: StoredIndex;

  constructor(userDataDir: string, agentDir?: string) {
    this.path = join(userDataDir, INDEX_FILE_NAME);
    this.agentDir = agentDir;
  }

  async list(projectId: string, cwd: string): Promise<Thread[]> {
    const project = await this.requireProject(projectId, cwd);
    return project.sessions.map(({ path: _path, ...thread }) => ({ ...thread, running: false }));
  }

  async resolve(projectId: string, cwd: string, threadId: string): Promise<{ id: string; path: string }> {
    const cached = this.load().projects[projectId];
    const cacheWasFresh = this.isProjectFresh(projectId, cached, cwd);
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
    const currentProject = data.projects[projectId]?.cwd === cwd ? data.projects[projectId] : undefined;
    const sessions = currentProject ? [...currentProject.sessions] : [];
    const index = sessions.findIndex(({ id }) => id === thread.id);
    const existing = index === -1 ? undefined : sessions[index];
    const explicitSessions = [...(currentProject?.explicitSessions ?? [])];
    const explicitIndex = explicitSessions.findIndex(({ session }) => session.id === thread.id);
    const explicitSession = explicitIndex === -1 ? undefined : explicitSessions[explicitIndex]?.session;
    if (explicitSession && resolve(explicitSession.path) !== resolve(sessionFile)) {
      throw new Error(`Pi session ID ${thread.id} is already registered at another path`);
    }
    const summary =
      explicitIndex !== -1 && existing && hasAutomaticSessionTitle(thread)
        ? { ...thread, title: existing.title, preview: existing.preview }
        : thread;
    const next = indexedSession(summary, sessionFile, existing);
    if (index === -1) sessions.push(next);
    else sessions[index] = next;
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    if (explicitIndex !== -1) {
      explicitSessions[explicitIndex] = {
        session: next,
        fileFingerprint: requireExplicitSessionFingerprint(sessionFile, thread.id),
      };
    }
    data.projects[projectId] = {
      cwd,
      sessionDirectory: currentProject?.sessionDirectory ?? (explicitIndex === -1 ? dirname(sessionFile) : null),
      directoryFingerprint: explicitIndex === -1 ? null : (currentProject?.directoryFingerprint ?? null),
      backfillComplete: currentProject?.backfillComplete ?? false,
      explicitSessions,
      sessions,
    };
    this.persist();
  }

  registerExternalSession(projectId: string, cwd: string, sessionFile: string, thread: Thread): void {
    const fileFingerprint = requireExplicitSessionFingerprint(sessionFile, thread.id);
    const data = this.load();
    const currentProject = data.projects[projectId]?.cwd === cwd ? data.projects[projectId] : undefined;
    const sessions = [...(currentProject?.sessions ?? [])];
    const index = sessions.findIndex(({ id }) => id === thread.id);
    const existing = index === -1 ? undefined : sessions[index];
    if (existing && resolve(existing.path) !== resolve(sessionFile)) {
      throw new Error(`Pi session ID ${thread.id} is already registered at another path`);
    }
    const next = indexedSession(thread, sessionFile, existing);
    if (index === -1) sessions.push(next);
    else sessions[index] = next;
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    const explicitSessions = [...(currentProject?.explicitSessions ?? [])];
    const explicitIndex = explicitSessions.findIndex(({ session }) => session.id === thread.id);
    const explicit = { session: next, fileFingerprint };
    if (explicitIndex === -1) explicitSessions.push(explicit);
    else explicitSessions[explicitIndex] = explicit;
    data.projects[projectId] = {
      cwd,
      sessionDirectory: currentProject?.sessionDirectory ?? null,
      directoryFingerprint: currentProject?.directoryFingerprint ?? null,
      backfillComplete: currentProject?.backfillComplete ?? false,
      explicitSessions,
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
    const explicit = project.explicitSessions.find(({ session: candidate }) => candidate.id === threadId);
    if (explicit) {
      explicit.session = { ...session };
      explicit.fileFingerprint = requireExplicitSessionFingerprint(session.path, session.id);
    } else {
      project.directoryFingerprint = null;
    }
    this.persist();
  }

  remove(projectId: string, threadId: string): void {
    const data = this.load();
    const project = data.projects[projectId];
    if (!project) return;
    const explicit = project.explicitSessions.some(({ session }) => session.id === threadId);
    project.sessions = project.sessions.filter(({ id }) => id !== threadId);
    project.explicitSessions = project.explicitSessions.filter(({ session }) => session.id !== threadId);
    if (!explicit) project.directoryFingerprint = null;
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
    const currentProject = data.projects[projectId]?.cwd === cwd ? data.projects[projectId] : undefined;
    if (this.agentDir) migrateLegacyGeneralSessionDirectory(projectId, cwd, this.agentDir);
    const configuredDirectory = this.agentDir ? resolveDesktopSessionDirectory(projectId, this.agentDir) : undefined;
    const directoryChanged =
      configuredDirectory !== undefined && currentProject?.sessionDirectory !== configuredDirectory;
    const currentExplicitSessions = (currentProject?.explicitSessions ?? []).map((explicit) =>
      directoryChanged && this.agentDir
        ? {
            ...explicit,
            session: {
              ...explicit.session,
              path: remapLegacyGeneralSessionPath(projectId, cwd, this.agentDir, explicit.session.path),
            },
          }
        : explicit,
    );
    const knownDirectory = configuredDirectory ?? currentProject?.sessionDirectory ?? null;
    const fingerprintBeforeScan = fingerprintSessionDirectory(knownDirectory);
    const rootSessions = configuredDirectory
      ? await SessionManager.list(cwd, configuredDirectory)
      : await SessionManager.list(cwd);
    const sessionDirectory = knownDirectory ?? (rootSessions[0] ? dirname(rootSessions[0].path) : null);
    const backfill =
      currentProject?.backfillComplete && !directoryChanged
        ? { sessions: [], complete: true }
        : sessionDirectory
          ? await listNestedSessionInfos(sessionDirectory)
          : { sessions: [], complete: false };
    const validExplicitSessions = (
      await Promise.all(
        currentExplicitSessions.map(async (explicit) => {
          const fileFingerprint = explicitSessionFingerprint(explicit.session.path, explicit.session.id);
          if (!fileFingerprint) return undefined;
          return refreshExplicitSession(projectId, explicit, fileFingerprint);
        }),
      )
    ).filter((explicit): explicit is ExplicitIndexedSession => explicit !== undefined);
    const candidates: Array<{ session: SessionInfo; originHint?: ForkDescriptor["origin"] }> = [
      ...rootSessions.map((session) => ({ session })),
      ...backfill.sessions.map((session) => ({ session, originHint: "subagent" })),
    ];
    const sessionPathById = new Map<string, string>();
    for (const { session } of validExplicitSessions) {
      registerSessionIdentity(sessionPathById, session.id, session.path);
    }
    for (const { session } of candidates) registerSessionIdentity(sessionPathById, session.id, session.path);
    const threadIdByPath = new Map(validExplicitSessions.map(({ session }) => [resolve(session.path), session.id]));
    for (const { session } of candidates) threadIdByPath.set(resolve(session.path), session.id);
    const rebuiltSessions = await Promise.all(
      candidates.map(async ({ session, originHint }): Promise<IndexedSession> => {
        const parentThreadId = session.parentSessionPath
          ? threadIdByPath.get(resolve(session.parentSessionPath))
          : undefined;
        const fork = parentThreadId || originHint ? await readForkDescriptor(session, originHint) : undefined;
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
    const rootIds = new Set(rootSessions.map(({ id }) => id));
    const explicitById = new Map(
      validExplicitSessions
        .filter(({ session }) => !rootIds.has(session.id))
        .map((explicit): [string, ExplicitIndexedSession] => [explicit.session.id, explicit]),
    );
    for (const session of rebuiltSessions.slice(rootSessions.length)) {
      if (rootIds.has(session.id) || explicitById.has(session.id)) continue;
      const fileFingerprint = explicitSessionFingerprint(session.path, session.id);
      if (fileFingerprint) explicitById.set(session.id, { session, fileFingerprint });
    }
    const explicitSessions = [...explicitById.values()];
    const sessionsById = new Map(
      rebuiltSessions.slice(0, rootSessions.length).map((session): [string, IndexedSession] => [session.id, session]),
    );
    for (const { session } of explicitSessions) sessionsById.set(session.id, session);
    const sessions = [...sessionsById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    const project = {
      cwd,
      sessionDirectory,
      directoryFingerprint: fingerprintBeforeScan,
      backfillComplete: backfill.complete,
      explicitSessions,
      sessions,
    };
    data.projects[projectId] = project;
    this.persist();
    return project;
  }

  private async requireProject(projectId: string, cwd: string): Promise<IndexedProject> {
    const project = this.load().projects[projectId];
    if (this.isProjectFresh(projectId, project, cwd)) return project;
    return this.rebuild(projectId, cwd);
  }

  private isProjectFresh(
    projectId: string,
    project: IndexedProject | undefined,
    cwd: string,
  ): project is IndexedProject {
    const configuredDirectory = this.agentDir ? resolveDesktopSessionDirectory(projectId, this.agentDir) : undefined;
    return (
      project?.cwd === cwd &&
      (configuredDirectory === undefined || project.sessionDirectory === configuredDirectory) &&
      project.backfillComplete &&
      project.directoryFingerprint !== null &&
      fingerprintSessionDirectory(project.sessionDirectory) === project.directoryFingerprint &&
      project.explicitSessions.every(
        ({ session, fileFingerprint }) => explicitSessionFingerprint(session.path, session.id) === fileFingerprint,
      )
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
      typeof project.backfillComplete === "boolean" &&
      Array.isArray(project.explicitSessions) &&
      project.explicitSessions.every(isExplicitIndexedSession) &&
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
    (value.agentName === undefined || typeof value.agentName === "string") &&
    typeof value.path === "string"
  );
}

function isExplicitIndexedSession(value: unknown): value is ExplicitIndexedSession {
  return isRecord(value) && isIndexedSession(value.session) && typeof value.fileFingerprint === "string";
}

function hasAutomaticSessionTitle(thread: Thread): boolean {
  const firstPreviewLine = thread.preview
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (
    thread.title === "新会话" ||
    thread.title === truncateTitle(thread.preview) ||
    (firstPreviewLine !== undefined && thread.title === truncateTitle(firstPreviewLine))
  );
}

function indexedSession(thread: Thread, sessionFile: string, existing?: IndexedSession): IndexedSession {
  const parentThreadId = thread.parentThreadId ?? existing?.parentThreadId;
  const origin = thread.origin ?? existing?.origin;
  const agentName = thread.agentName ?? existing?.agentName;
  return {
    ...thread,
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(origin ? { origin } : {}),
    ...(agentName ? { agentName } : {}),
    running: false,
    path: sessionFile,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerSessionIdentity(paths: Map<string, string>, sessionId: string, sessionFile: string): void {
  const path = resolve(sessionFile);
  const existing = paths.get(sessionId);
  if (existing && existing !== path) {
    throw new Error(`Pi session ID ${sessionId} is already registered at another path`);
  }
  paths.set(sessionId, path);
}

async function refreshExplicitSession(
  projectId: string,
  explicit: ExplicitIndexedSession,
  fileFingerprint: string,
): Promise<ExplicitIndexedSession> {
  if (fileFingerprint === explicit.fileFingerprint) {
    return { session: { ...explicit.session, running: false }, fileFingerprint };
  }
  const listed = await SessionManager.listAll(dirname(explicit.session.path));
  const session = listed.find(
    ({ id, path }) => id === explicit.session.id && resolve(path) === resolve(explicit.session.path),
  );
  if (!session) throw new Error(`Unable to refresh external Pi session: ${explicit.session.path}`);
  const fork = explicit.session.origin ? await readForkDescriptor(session, explicit.session.origin) : undefined;
  return {
    session: {
      ...explicit.session,
      id: session.id,
      projectId,
      title: fork?.title || session.name || session.firstMessage || "新会话",
      createdAt: session.created.getTime(),
      updatedAt: session.modified.getTime(),
      messageCount: session.messageCount,
      preview: fork?.title || session.firstMessage,
      running: false,
      path: session.path,
    },
    fileFingerprint,
  };
}

interface ForkDescriptor {
  title: string;
  prompt?: string;
  origin: "branch" | "subagent";
}

async function readForkDescriptor(
  session: SessionInfo,
  originHint?: ForkDescriptor["origin"],
): Promise<ForkDescriptor> {
  const activity = await readForkActivity(session.path, session.created.getTime());
  const origin =
    originHint ??
    (activity.prompt?.includes("You are a delegated subagent running from a fork of the parent session.")
      ? "subagent"
      : "branch");
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
      .find((line) => line && !line.startsWith("[Read from:"));
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

async function listNestedSessionInfos(
  sessionDirectory: string,
): Promise<{ sessions: SessionInfo[]; complete: boolean }> {
  const directories: string[] = [];
  let complete = true;
  let parentEntries: Dirent[];
  try {
    parentEntries = readdirSync(sessionDirectory, { withFileTypes: true });
  } catch {
    return { sessions: [], complete: false };
  }
  for (const parentEntry of parentEntries) {
    if (!parentEntry.isDirectory()) continue;
    const parentSessionFile = join(sessionDirectory, `${parentEntry.name}.jsonl`);
    if (!existsSync(parentSessionFile)) continue;
    const parentDirectory = join(sessionDirectory, parentEntry.name);
    let runGroupEntries: Dirent[];
    try {
      runGroupEntries = readdirSync(parentDirectory, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const runGroupEntry of runGroupEntries) {
      if (!runGroupEntry.isDirectory() || !/^[a-f0-9]{8}$/i.test(runGroupEntry.name)) continue;
      const runGroupDirectory = join(parentDirectory, runGroupEntry.name);
      let runEntries: Dirent[];
      try {
        runEntries = readdirSync(runGroupDirectory, { withFileTypes: true });
      } catch {
        complete = false;
        continue;
      }
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory() || !/^run-\d+$/.test(runEntry.name)) continue;
        const runDirectory = join(runGroupDirectory, runEntry.name);
        if (existsSync(join(runDirectory, "session.jsonl"))) directories.push(runDirectory);
      }
    }
  }

  const sessions: SessionInfo[] = [];
  for (let index = 0; index < directories.length; index += 10) {
    const batchDirectories = directories.slice(index, index + 10);
    const batch = await Promise.all(batchDirectories.map((directory) => SessionManager.listAll(directory)));
    batch.forEach((listed, batchIndex) => {
      const directory = batchDirectories[batchIndex];
      if (listed.length === 0 && directory && existsSync(join(directory, "session.jsonl"))) complete = false;
      for (const session of listed) {
        if (session.parentSessionPath) sessions.push(session);
        else {
          const parentSessionPath = inferNestedParentSessionPath(sessionDirectory, session.path);
          sessions.push(parentSessionPath ? { ...session, parentSessionPath } : session);
        }
      }
    });
  }
  return { sessions, complete };
}

function inferNestedParentSessionPath(sessionDirectory: string, sessionFile: string): string | undefined {
  const parts = relative(sessionDirectory, sessionFile).split(sep);
  if (
    parts.length !== 4 ||
    !parts[0] ||
    !/^[a-f0-9]{8}$/i.test(parts[1] ?? "") ||
    !/^run-\d+$/.test(parts[2] ?? "") ||
    parts[3] !== "session.jsonl"
  ) {
    return undefined;
  }
  const parentSessionPath = join(sessionDirectory, `${parts[0]}.jsonl`);
  return existsSync(parentSessionPath) ? parentSessionPath : undefined;
}

function requireExplicitSessionFingerprint(sessionFile: string, expectedId: string): string {
  const fingerprint = explicitSessionFingerprint(sessionFile, expectedId);
  if (!fingerprint) throw new InvalidExternalSessionError(sessionFile);
  return fingerprint;
}

function explicitSessionFingerprint(sessionFile: string, expectedId: string): string | null {
  let descriptor: number | undefined;
  try {
    const stats = lstatSync(sessionFile, { bigint: true });
    if (!stats.isFile()) return null;
    descriptor = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(8 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return null;
    const header: unknown = JSON.parse(firstLine);
    if (!isRecord(header) || header.type !== "session" || header.id !== expectedId) return null;
    const hash = createHash("sha256");
    hash.update(stats.dev.toString());
    hash.update("\0");
    hash.update(stats.ino.toString());
    hash.update("\0");
    hash.update(stats.size.toString());
    hash.update("\0");
    hash.update(stats.mtimeNs.toString());
    hash.update("\0");
    hash.update(stats.ctimeNs.toString());
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
