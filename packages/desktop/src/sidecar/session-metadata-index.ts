import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionRemovePolicy, SessionRemoveResult, Thread } from "../shared/contracts.ts";
import { collectThreadDescendantIds } from "../shared/thread-tree.ts";
import {
  migrateLegacyGeneralSessionDirectory,
  remapLegacyGeneralSessionPath,
  resolveDesktopSessionDirectory,
} from "./desktop-session-directory.ts";

const INDEX_VERSION = 5;
const INDEX_FILE_NAME = "session-metadata-index.json";

interface IndexedSession extends Thread {
  path: string;
}

interface ExplicitIndexedSession {
  session: IndexedSession;
}

export interface SessionRemovalPlan {
  projectId: string;
  cwd: string;
  removedSessions: Array<{ id: string; path: string }>;
  reparentedSessions: Array<{
    session: IndexedSession;
    previousParentPath: string;
    nextParentPath?: string;
  }>;
  result: SessionRemoveResult;
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
      explicitSessions[explicitIndex] = { session: next };
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
    const explicit = { session: next };
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

  async planRemoval(
    projectId: string,
    cwd: string,
    threadId: string,
    policy: SessionRemovePolicy,
  ): Promise<SessionRemovalPlan> {
    const project = await this.requireProject(projectId, cwd);
    const target = project.sessions.find(({ id }) => id === threadId);
    if (!target) throw new Error(`Pi session does not exist: ${threadId}`);
    const sessionsById = new Map(project.sessions.map((session) => [session.id, session]));
    const descendantIds = collectThreadDescendantIds(project.sessions, threadId);
    const removedIds = policy === "subtree" ? new Set([threadId, ...descendantIds]) : new Set([threadId]);
    const removedSessions = [...removedIds].map((id) => {
      const session = sessionsById.get(id);
      if (!session) throw new Error(`Pi session removal plan is missing ${id}`);
      return { id, path: session.path };
    });
    const nextParent = target.parentThreadId ? sessionsById.get(target.parentThreadId) : undefined;
    const reparentedSessions =
      policy === "reparent"
        ? project.sessions.flatMap((session) => {
            if (session.parentThreadId !== threadId) return [];
            const next = withParentThreadId(session, target.parentThreadId);
            return [
              {
                session: next,
                previousParentPath: target.path,
                ...(nextParent ? { nextParentPath: nextParent.path } : {}),
              },
            ];
          })
        : [];
    return {
      projectId,
      cwd,
      removedSessions,
      reparentedSessions,
      result: {
        removedThreadIds: removedSessions.map(({ id }) => id),
        reparentedThreads: reparentedSessions.map(({ session: { path: _path, ...thread } }) => thread),
      },
    };
  }

  isRemovalApplied(plan: SessionRemovalPlan): boolean {
    const project = this.load().projects[plan.projectId];
    if (!project || project.cwd !== plan.cwd) return false;
    if (plan.removedSessions.some(({ id }) => project.sessions.some((session) => session.id === id))) return false;
    return plan.reparentedSessions.every(({ session }) => {
      const current = project.sessions.find(({ id }) => id === session.id);
      return current?.parentThreadId === session.parentThreadId;
    });
  }

  applyRemoval(plan: SessionRemovalPlan): SessionRemoveResult {
    const data = this.load();
    const project = data.projects[plan.projectId];
    if (!project || project.cwd !== plan.cwd) {
      throw new Error(`Session metadata index is missing project ${plan.projectId}`);
    }
    const removedIds = new Set(plan.removedSessions.map(({ id }) => id));
    for (const removed of plan.removedSessions) {
      const current = project.sessions.find(({ id }) => id === removed.id);
      if (!current || resolve(current.path) !== resolve(removed.path)) {
        throw new Error(`Pi session removal plan is stale for ${removed.id}`);
      }
    }
    const reparentedById = new Map(plan.reparentedSessions.map(({ session }) => [session.id, session]));
    const previousSessions = project.sessions;
    const previousExplicitSessions = project.explicitSessions;
    const previousFingerprint = project.directoryFingerprint;
    project.sessions = project.sessions
      .filter(({ id }) => !removedIds.has(id))
      .map((session) => reparentedById.get(session.id) ?? session);
    project.explicitSessions = project.explicitSessions
      .filter(({ session }) => !removedIds.has(session.id))
      .map((explicit) => ({ session: reparentedById.get(explicit.session.id) ?? explicit.session }));
    project.directoryFingerprint = null;
    try {
      this.persist();
      return plan.result;
    } catch (error) {
      project.sessions = previousSessions;
      project.explicitSessions = previousExplicitSessions;
      project.directoryFingerprint = previousFingerprint;
      throw error;
    }
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
    const validExplicitSessions = currentExplicitSessions.filter(({ session }) => existsSync(session.path));
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
      explicitById.set(session.id, { session });
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
      project.explicitSessions.every(({ session }) => existsSync(session.path))
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
  return isRecord(value) && isIndexedSession(value.session);
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

function withParentThreadId(session: IndexedSession, parentThreadId: string | undefined): IndexedSession {
  const { parentThreadId: _currentParent, ...rest } = session;
  return parentThreadId ? { ...rest, parentThreadId } : rest;
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
