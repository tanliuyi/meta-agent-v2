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
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SessionMentionCandidate, SessionRemovePolicy, SessionRemoveResult, Thread } from "../shared/contracts.ts";
import {
  previewFirstLines,
  THREAD_ASSISTANT_PREVIEW_MAX_CHARS,
  THREAD_USER_PREVIEW_MAX_CHARS,
} from "../shared/contracts.ts";
import { collectThreadDescendantIds } from "../shared/thread-tree.ts";
import {
  migrateLegacyGeneralSessionDirectory,
  remapLegacyGeneralSessionPath,
  resolveDesktopSessionDirectory,
} from "./desktop-session-directory.ts";

const INDEX_VERSION = 6;
const INDEX_FILE_NAME = "session-metadata-index.json";
/** 会话文件尾部读取块大小与上限（避免全量读取只为最后一条消息）。 */
const LAST_MESSAGE_PREVIEW_TAIL_BYTES = 256 * 1024;
const LAST_MESSAGE_PREVIEW_MAX_TAIL_BYTES = 4 * 1024 * 1024;
/** 重建索引时并行读取会话文件的上限。 */
const MAX_CONCURRENT_SESSION_FILE_READS = 10;

interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

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
    /** 提升为根：清除 parentSession header 并写入持久化 promotedRoot 标记。 */
    promoteToRoot?: boolean;
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

  /** 同 list，但保留 session.jsonl 绝对路径（@ 提及会话引用用）。 */
  async listWithPaths(projectId: string, cwd: string): Promise<SessionMentionCandidate[]> {
    const project = await this.requireProject(projectId, cwd);
    return project.sessions.map((session) => ({ ...session, running: false }));
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

  /** 将子会话提升为 root：不删除任何会话，仅清除目标 header 的 parentSession 并同步索引。 */
  async planPromotion(projectId: string, cwd: string, threadId: string): Promise<SessionRemovalPlan> {
    const project = await this.requireProject(projectId, cwd);
    const target = project.sessions.find(({ id }) => id === threadId);
    if (!target) throw new Error(`Pi session does not exist: ${threadId}`);
    const parentThreadId = target.parentThreadId;
    if (!parentThreadId) throw new Error(`Pi session is already a root session: ${threadId}`);
    const parent = project.sessions.find(({ id }) => id === parentThreadId);
    if (!parent) throw new Error(`Pi session parent does not exist: ${parentThreadId}`);
    const promoted = promotedSession(target);
    const { path: _path, ...thread } = promoted;
    return {
      projectId,
      cwd,
      removedSessions: [],
      reparentedSessions: [
        {
          session: promoted,
          previousParentPath: parent.path,
          promoteToRoot: true,
        },
      ],
      result: {
        removedThreadIds: [],
        reparentedThreads: [thread],
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
    const knownDirectory =
      configuredDirectory ??
      (this.agentDir ? defaultSessionDirectory(cwd, this.agentDir) : (currentProject?.sessionDirectory ?? null));
    const fingerprintBeforeScan = fingerprintSessionDirectory(knownDirectory);
    const rootSessions = knownDirectory
      ? await listSessionInfos(knownDirectory, cwd, configuredDirectory !== undefined)
      : [];
    const sessionDirectory = knownDirectory;
    const validExplicitSessions = currentExplicitSessions.filter(({ session }) => existsSync(session.path));
    const candidates: Array<{ session: SessionInfo }> = rootSessions.map((session) => ({ session }));
    const sessionPathById = new Map<string, string>();
    for (const { session } of validExplicitSessions) {
      registerSessionIdentity(sessionPathById, session.id, session.path);
    }
    for (const { session } of candidates) registerSessionIdentity(sessionPathById, session.id, session.path);
    const threadIdByPath = new Map(validExplicitSessions.map(({ session }) => [resolve(session.path), session.id]));
    for (const { session } of candidates) threadIdByPath.set(resolve(session.path), session.id);
    const knownSessionsById = new Map(currentProject?.sessions.map((session) => [session.id, session]));
    const rebuiltCandidates = await mapWithConcurrency(
      candidates,
      MAX_CONCURRENT_SESSION_FILE_READS,
      async ({ session }): Promise<IndexedSession | undefined> => {
        const parentThreadId = session.parentSessionPath
          ? threadIdByPath.get(resolve(session.parentSessionPath))
          : undefined;
        let fork: ForkDescriptor | undefined;
        let lastMessagePreview: Awaited<ReturnType<typeof readLastMessagePreview>>;
        try {
          [fork, lastMessagePreview] = await Promise.all([
            parentThreadId ? readForkDescriptor(session) : Promise.resolve(undefined),
            readLastMessagePreview(session.path),
          ]);
        } catch (error) {
          if (isSessionFileUnavailable(error)) return undefined;
          throw error;
        }
        return {
          id: session.id,
          projectId,
          title: fork?.title || session.name || session.firstMessage || "新会话",
          createdAt: session.created.getTime(),
          updatedAt: Math.max(knownSessionsById.get(session.id)?.updatedAt ?? 0, session.modified.getTime()),
          messageCount: session.messageCount,
          preview: fork?.title || session.firstMessage,
          ...lastMessagePreview,
          archived: false,
          running: false,
          ...(parentThreadId ? { parentThreadId } : {}),
          ...(fork?.origin ? { origin: fork.origin } : {}),
          path: session.path,
        };
      },
    );
    const rebuiltRootSessions = rebuiltCandidates.filter((session): session is IndexedSession => session !== undefined);
    const rootIds = new Set(rebuiltRootSessions.map(({ id }) => id));
    const explicitById = new Map(
      validExplicitSessions
        .filter(({ session }) => !rootIds.has(session.id))
        .map((explicit): [string, ExplicitIndexedSession] => [explicit.session.id, explicit]),
    );
    const explicitSessions = [...explicitById.values()];
    const sessionsById = new Map(rebuiltRootSessions.map((session): [string, IndexedSession] => [session.id, session]));
    for (const { session } of explicitSessions) sessionsById.set(session.id, session);
    const sessions = [...sessionsById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    const project = {
      cwd,
      sessionDirectory,
      directoryFingerprint: fingerprintBeforeScan,
      backfillComplete: true,
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
    const previewsUpgraded =
      project?.sessions.every((session) => session.origin === "subagent" || "lastAssistantPreview" in session) ?? false;
    return (
      project?.cwd === cwd &&
      (configuredDirectory === undefined || project.sessionDirectory === configuredDirectory) &&
      project.backfillComplete &&
      previewsUpgraded &&
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
    (value.lastUserPreview === undefined || typeof value.lastUserPreview === "string") &&
    (value.lastAssistantPreview === undefined || typeof value.lastAssistantPreview === "string") &&
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

/** 提升为 root 后成为普通会话：清除子会话身份（parent、subagent origin 与 agentName）。 */
function promotedSession(session: IndexedSession): IndexedSession {
  const { parentThreadId: _parent, origin: _origin, agentName: _agentName, ...rest } = session;
  return rest;
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

/** 以固定并发上限映射异步任务，避免同时打开大量会话文件。 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 读取会话文件最后一条可见消息（user/assistant）的前两行，用于侧边栏 hover 预览。 */
async function readLastMessagePreview(
  sessionFile: string,
): Promise<{ lastUserPreview?: string; lastAssistantPreview?: string }> {
  const fileSize = statSync(sessionFile).size;
  let lastUserPreview: string | undefined;
  let lastRole: string | undefined;
  let lastText: string | undefined;
  // 只读文件尾部：最后一条消息几乎总在末尾；块首行可能被 UTF-8 边界截断，JSON.parse 失败自然跳过。
  let tailStart = Math.max(0, fileSize - LAST_MESSAGE_PREVIEW_TAIL_BYTES);
  for (;;) {
    const lines = createInterface({
      input: createReadStream(sessionFile, { encoding: "utf8", start: tailStart }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) continue;
      const role = value.message.role;
      const text = messageText(value.message.content).trim();
      if (role !== "user" && role !== "assistant") continue;
      if (!text) continue;
      lastRole = role;
      lastText = text;
      if (role === "user") lastUserPreview = previewFirstLines(text, THREAD_USER_PREVIEW_MAX_CHARS);
    }
    // 未解析到可见消息，或仅缺少 assistant 前的 user 时，继续向前扩展重读。
    if (
      (lastRole === undefined || (lastRole === "assistant" && lastUserPreview === undefined)) &&
      tailStart > 0 &&
      fileSize - tailStart < LAST_MESSAGE_PREVIEW_MAX_TAIL_BYTES
    ) {
      tailStart = Math.max(0, tailStart - LAST_MESSAGE_PREVIEW_TAIL_BYTES);
      continue;
    }
    break;
  }
  const lastAssistantPreview =
    lastRole === "assistant" && lastText ? previewFirstLines(lastText, THREAD_ASSISTANT_PREVIEW_MAX_CHARS) : "";
  return { ...(lastUserPreview !== undefined ? { lastUserPreview } : {}), lastAssistantPreview };
}

function isSessionFileUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
  );
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

function defaultSessionDirectory(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

async function listSessionInfos(directory: string, cwd: string, filterCwd: boolean): Promise<SessionInfo[]> {
  const files = listSessionFiles(directory);
  const sessions = (await mapWithConcurrency(files, MAX_CONCURRENT_SESSION_FILE_READS, readSessionInfo)).filter(
    (session): session is SessionInfo => session !== undefined,
  );
  const resolvedCwd = normalizePath(cwd);
  return sessions
    .filter((session) => !filterCwd || normalizePath(session.cwd) === resolvedCwd)
    .sort((left, right) => right.modified.getTime() - left.modified.getTime());
}

async function readSessionInfo(sessionFile: string): Promise<SessionInfo | undefined> {
  try {
    const stats = statSync(sessionFile);
    const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let messageCount = 0;
    let firstMessage = "";
    let lastActivity = 0;
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      if (!header) {
        if (value.type !== "session" || typeof value.id !== "string" || typeof value.timestamp !== "string") {
          return undefined;
        }
        header = value;
        continue;
      }
      if (value.type === "session_info") {
        name = typeof value.name === "string" ? value.name.trim() || undefined : undefined;
        continue;
      }
      if (value.type !== "message" || !isRecord(value.message)) continue;
      messageCount += 1;
      const role = value.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = messageText(value.message.content).trim();
      if (!firstMessage && role === "user" && text) firstMessage = text;
      const entryTime = typeof value.timestamp === "string" ? new Date(value.timestamp).getTime() : 0;
      const messageTime = typeof value.message.timestamp === "number" ? value.message.timestamp : entryTime;
      if (Number.isFinite(messageTime)) lastActivity = Math.max(lastActivity, messageTime);
    }
    if (!header) return undefined;
    const timestamp = header.timestamp;
    if (typeof timestamp !== "string") return undefined;
    const created = new Date(timestamp);
    if (!Number.isFinite(created.getTime())) return undefined;
    return {
      path: sessionFile,
      id: String(header.id),
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      ...(name ? { name } : {}),
      ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
      created,
      modified: lastActivity > 0 ? new Date(lastActivity) : stats.mtime,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
  } catch {
    return undefined;
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function listSessionFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files.sort();
}

function fingerprintSessionDirectory(directory: string | null): string | null {
  if (directory === null) return null;
  try {
    const files = listSessionFiles(directory);
    const hash = createHash("sha256");
    for (const path of files) {
      const name = relative(directory, path);
      const stats = statSync(path, { bigint: true });
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
