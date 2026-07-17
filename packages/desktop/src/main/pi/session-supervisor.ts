import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  DraftSessionConfig,
  HostResponse,
  SendInput,
  SessionAttachment,
  SessionBootstrap,
  SessionControlState,
  SessionCreateInput,
  SessionPush,
  SessionPushPayload,
  SessionRunInput,
  Thread,
} from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { loadDraftSessionConfig } from "./session-configuration.ts";
import { SessionRuntime } from "./session-runtime.ts";

interface ProjectCatalog {
  items: Map<string, SessionInfo>;
  dirty: boolean;
  watcher?: FSWatcher;
}

interface RendererSubscription {
  attachmentId: string;
  projectId: string;
  threadId: string;
  send(update: SessionPush): void;
}

interface PendingRendererAttachment {
  requestId: symbol;
  projectId: string;
  threadId: string;
}

/** 管理 Pi session 生命周期、目录索引和 renderer 定向订阅。 */
export class SessionSupervisor {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly pendingRuntimes = new Map<string, Promise<SessionRuntime>>();
  private readonly catalogs = new Map<string, ProjectCatalog>();
  private readonly subscriptions = new Map<number, RendererSubscription>();
  private readonly pendingAttachments = new Map<number, PendingRendererAttachment>();
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  async list(projectId: string, includeArchived = false): Promise<Thread[]> {
    const catalog = await this.requireCatalog(projectId);
    const threads = new Map<string, Thread>();
    for (const item of catalog.items.values()) {
      const archived = this.projects.isArchived(projectId, item.id);
      if (archived && !includeArchived) continue;
      threads.set(
        item.id,
        threadFromInfo(projectId, item, archived, this.runtimes.get(runtimeKey(projectId, item.id))),
      );
    }
    for (const runtime of this.projectRuntimes(projectId)) {
      const archived = this.projects.isArchived(projectId, runtime.id);
      if (archived && !includeArchived) continue;
      threads.set(runtime.id, runtime.threadSummary(archived));
    }
    return [...threads.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getDraftConfig(projectId: string): Promise<DraftSessionConfig> {
    return loadDraftSessionConfig(this.projects.getCwd(projectId));
  }

  async create(input: SessionCreateInput): Promise<SessionBootstrap> {
    const runtime = await this.createRuntime(input.projectId, undefined, input);
    this.runtimes.set(runtimeKey(input.projectId, runtime.id), runtime);
    this.watchRuntimeDirectory(input.projectId, runtime);
    return runtime.bootstrap();
  }

  async attach(
    ownerId: number,
    projectId: string,
    threadId: string,
    send: (update: SessionPush) => void,
  ): Promise<SessionAttachment> {
    const requestId = Symbol("session-attachment");
    this.pendingAttachments.set(ownerId, { requestId, projectId, threadId });
    try {
      const runtime = await this.requireRuntime(projectId, threadId);
      const bootstrap = runtime.bootstrap();
      const attachmentId = randomUUID();
      if (this.pendingAttachments.get(ownerId)?.requestId === requestId) {
        this.pendingAttachments.delete(ownerId);
        this.subscriptions.set(ownerId, { attachmentId, projectId, threadId, send });
      }
      return { protocolVersion: bootstrap.protocolVersion, attachmentId, bootstrap };
    } catch (error) {
      if (this.pendingAttachments.get(ownerId)?.requestId === requestId) this.pendingAttachments.delete(ownerId);
      throw error;
    }
  }

  async run(request: SessionRunInput): Promise<void> {
    await (await this.requireRuntime(request.projectId, request.threadId)).run(request.input);
  }

  async enqueue(input: SendInput): Promise<void> {
    await (await this.requireRuntime(input.projectId, input.threadId)).enqueue(input);
  }

  async cancel(projectId: string, threadId: string): Promise<void> {
    await (await this.requireRuntime(projectId, threadId)).cancel();
  }

  async clearQueue(projectId: string, threadId: string): Promise<string[]> {
    return (await this.requireRuntime(projectId, threadId)).clearQueue();
  }

  async compact(projectId: string, threadId: string): Promise<void> {
    await (await this.requireRuntime(projectId, threadId)).compact();
  }

  async setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void> {
    await (await this.requireRuntime(projectId, threadId)).setModel(provider, modelId);
  }

  async setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void> {
    (await this.requireRuntime(projectId, threadId)).setThinking(level);
  }

  async rename(projectId: string, threadId: string, title: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeKey(projectId, threadId));
    if (runtime) runtime.rename(title);
    else {
      const item = await this.requireCatalogItem(projectId, threadId);
      SessionManager.open(item.path, undefined, this.projects.getCwd(projectId)).appendSessionInfo(title.trim());
      this.updateCatalogItem(projectId, { ...item, name: title.trim(), modified: new Date() });
    }
  }

  async archive(projectId: string, threadId: string, archived: boolean): Promise<void> {
    await this.projects.setArchived(projectId, threadId, archived);
  }

  async remove(projectId: string, threadId: string): Promise<void> {
    const key = runtimeKey(projectId, threadId);
    const runtime = this.runtimes.get(key);
    const file = runtime ? runtime.file : (await this.requireCatalogItem(projectId, threadId)).path;
    if (runtime) {
      await runtime.dispose();
      this.runtimes.delete(key);
    }
    if (file) await rm(file);
    this.catalogs.get(projectId)?.items.delete(threadId);
    this.clearPendingAttachments(projectId, threadId);
    this.clearSessionSubscriptions(projectId, threadId);
    await this.projects.removeWorkbench(projectId, threadId);
  }

  async removeProject(projectId: string): Promise<void> {
    const pending = [...this.pendingRuntimes.entries()]
      .filter(([key]) => key.startsWith(`${projectId}:`))
      .map(([, runtime]) => runtime);
    await Promise.allSettled(pending);
    const runtimes = this.projectRuntimes(projectId);
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    for (const runtime of runtimes) this.runtimes.delete(runtimeKey(projectId, runtime.id));
    const catalog = this.catalogs.get(projectId);
    catalog?.watcher?.close();
    this.catalogs.delete(projectId);
    for (const [ownerId, subscription] of this.subscriptions) {
      if (subscription.projectId === projectId) this.subscriptions.delete(ownerId);
    }
    for (const [ownerId, pending] of this.pendingAttachments) {
      if (pending.projectId === projectId) this.pendingAttachments.delete(ownerId);
    }
  }

  async respond(projectId: string, threadId: string, response: HostResponse): Promise<void> {
    (await this.requireRuntime(projectId, threadId)).respond(response);
  }

  detach(ownerId: number, attachmentId?: string): void {
    const current = this.subscriptions.get(ownerId);
    if (attachmentId !== undefined && current?.attachmentId !== attachmentId) return;
    this.pendingAttachments.delete(ownerId);
    if (!current) return;
    this.subscriptions.delete(ownerId);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.pendingRuntimes.values());
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
    this.pendingRuntimes.clear();
    for (const catalog of this.catalogs.values()) catalog.watcher?.close();
    this.catalogs.clear();
    this.subscriptions.clear();
    this.pendingAttachments.clear();
  }

  private async requireRuntime(projectId: string, threadId: string): Promise<SessionRuntime> {
    const key = runtimeKey(projectId, threadId);
    const current = this.runtimes.get(key);
    if (current) return current;
    const pending = this.pendingRuntimes.get(key);
    if (pending) return pending;
    const promise = this.openManager(projectId, threadId).then((manager) => this.createRuntime(projectId, manager));
    this.pendingRuntimes.set(key, promise);
    try {
      const runtime = await promise;
      this.runtimes.set(key, runtime);
      this.watchRuntimeDirectory(projectId, runtime);
      return runtime;
    } finally {
      this.pendingRuntimes.delete(key);
    }
  }

  private createRuntime(
    projectId: string,
    sessionManager?: SessionManager,
    createInput?: SessionCreateInput,
  ): Promise<SessionRuntime> {
    return SessionRuntime.create({
      projectId,
      cwd: this.projects.getCwd(projectId),
      sessionManager,
      createInput,
      push: (update) => this.publish(update),
      onSummaryChanged: (runtime) => this.updateRuntimeCatalog(runtime),
    });
  }

  private async openManager(projectId: string, threadId: string): Promise<SessionManager> {
    const item = await this.requireCatalogItem(projectId, threadId);
    return SessionManager.open(item.path, undefined, this.projects.getCwd(projectId));
  }

  private async requireCatalog(projectId: string): Promise<ProjectCatalog> {
    const current = this.catalogs.get(projectId);
    if (current && !current.dirty) return current;
    const stored = await SessionManager.list(this.projects.getCwd(projectId));
    const catalog = current ?? { items: new Map<string, SessionInfo>(), dirty: false };
    catalog.items = new Map(stored.map((item) => [item.id, item]));
    catalog.dirty = false;
    this.catalogs.set(projectId, catalog);
    if (!catalog.watcher && stored[0]) this.watchDirectory(catalog, dirname(stored[0].path));
    return catalog;
  }

  private async requireCatalogItem(projectId: string, threadId: string): Promise<SessionInfo> {
    let catalog = await this.requireCatalog(projectId);
    let item = catalog.items.get(threadId);
    if (!item) {
      catalog.dirty = true;
      catalog = await this.requireCatalog(projectId);
      item = catalog.items.get(threadId);
    }
    if (!item) throw new Error(`Pi session 不存在: ${threadId}`);
    return item;
  }

  private updateRuntimeCatalog(runtime: SessionRuntime): void {
    const file = runtime.file;
    if (!file) return;
    const summary = runtime.threadSummary(this.projects.isArchived(runtime.projectId, runtime.id));
    this.updateCatalogItem(runtime.projectId, {
      path: file,
      id: runtime.id,
      cwd: runtime.cwd,
      name: summary.title,
      created: new Date(summary.createdAt),
      modified: new Date(summary.updatedAt),
      messageCount: summary.messageCount,
      firstMessage: summary.preview,
      allMessagesText: summary.preview,
    });
  }

  private updateCatalogItem(projectId: string, item: SessionInfo): void {
    const catalog = this.catalogs.get(projectId);
    catalog?.items.set(item.id, item);
    if (catalog && !catalog.watcher) this.watchDirectory(catalog, dirname(item.path));
  }

  private watchRuntimeDirectory(projectId: string, runtime: SessionRuntime): void {
    const catalog = this.catalogs.get(projectId);
    if (!catalog || catalog.watcher) return;
    this.watchDirectory(catalog, runtime.session.sessionManager.getSessionDir());
  }

  private watchDirectory(catalog: ProjectCatalog, directory: string): void {
    try {
      catalog.watcher = watch(directory, () => {
        catalog.dirty = true;
      });
    } catch {
      catalog.watcher = undefined;
    }
  }

  private publish(update: SessionPushPayload): void {
    for (const subscription of this.subscriptions.values()) {
      const isActiveSession = subscription.projectId === update.projectId && subscription.threadId === update.threadId;
      if (update.type !== "control" && !isActiveSession) continue;
      subscription.send({ ...update, attachmentId: subscription.attachmentId });
    }
  }

  private clearSessionSubscriptions(projectId: string, threadId: string): void {
    for (const [ownerId, subscription] of this.subscriptions) {
      if (subscription.projectId === projectId && subscription.threadId === threadId)
        this.subscriptions.delete(ownerId);
    }
  }

  private clearPendingAttachments(projectId: string, threadId: string): void {
    for (const [ownerId, pending] of this.pendingAttachments) {
      if (pending.projectId === projectId && pending.threadId === threadId) this.pendingAttachments.delete(ownerId);
    }
  }

  private projectRuntimes(projectId: string): SessionRuntime[] {
    return [...this.runtimes.values()].filter((runtime) => runtime.projectId === projectId);
  }
}

function runtimeKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}

function threadFromInfo(projectId: string, item: SessionInfo, archived: boolean, runtime?: SessionRuntime): Thread {
  if (runtime) return runtime.threadSummary(archived);
  return {
    id: item.id,
    projectId,
    title: item.name || item.firstMessage || "新会话",
    createdAt: item.created.getTime(),
    updatedAt: item.modified.getTime(),
    messageCount: item.messageCount,
    preview: item.firstMessage,
    archived,
    running: false,
  };
}
