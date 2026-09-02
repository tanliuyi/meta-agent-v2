import { randomUUID } from "node:crypto";
import type {
  ClearedQueue,
  DraftSessionConfig,
  HostResponse,
  OpenPluginCallArtifactInput,
  SessionAttachInput,
  SessionAttachment,
  SessionBootstrap,
  SessionBranchInput,
  SessionBranchResult,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionImageResource,
  SessionMentionCandidate,
  SessionPromptInput,
  SessionPush,
  SessionPushPayload,
  SessionReloadInput,
  SessionRemovePolicy,
  SessionRemoveResult,
  SessionResourceReloadInput,
  Thread,
} from "../../shared/contracts.ts";
import type {
  SessionCheckpointDiffInput,
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreInput,
  SessionCheckpointRestoreResult,
} from "../../shared/pi-rewind-contracts.ts";
import type { ThreadWorkerRegistry } from "../sidecar/thread-worker-registry.ts";
import type { ProjectStore } from "../store/project-store.ts";

interface RendererSubscription {
  attachmentId: string;
  projectId: string;
  threadId: string;
  send(update: SessionPush): void;
  pendingEvents: number;
  pendingBytes: number;
  resyncing: boolean;
}

interface PendingRendererAttachment {
  projectId: string;
  threadId: string;
}

interface PendingDeliveryAck {
  workerInstanceId: string;
  sidecarSequence: number;
  consumerIds: Set<string>;
  consumerBytes: Map<string, number>;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionSupervisorOptions {
  log?(scope: string, text: string): void;
}

const MAX_ATTACHMENT_PENDING_EVENTS = 128;
const MAX_ATTACHMENT_PENDING_BYTES = 16 * 1024 * 1024;
const DELIVERY_ACK_TIMEOUT_MS = 5_000;

/** Electron-only facade for attachment leases, ProjectStore overlays, and sidecar routing. */
export class SessionSupervisor {
  private readonly subscriptions = new Map<number, Map<string, RendererSubscription>>();
  private readonly pendingAttachments = new Map<number, Map<string, PendingRendererAttachment>>();
  private readonly pendingDeliveryAcks = new Map<string, PendingDeliveryAck>();
  private runtimeStatusSequence = 0;
  private readonly projects: ProjectStore;
  private readonly workers: ThreadWorkerRegistry;
  private readonly log?: SessionSupervisorOptions["log"];

  constructor(projects: ProjectStore, workers: ThreadWorkerRegistry, options: SessionSupervisorOptions = {}) {
    this.projects = projects;
    this.workers = workers;
    this.log = options.log;
  }

  async list(projectId: string, includeArchived = false): Promise<Thread[]> {
    return (await this.workers.list(projectId))
      .map((thread) => ({ ...thread, archived: this.projects.isArchived(projectId, thread.id) }))
      .filter((thread) => includeArchived || !thread.archived);
  }

  /** 同 list，但保留 session.jsonl 绝对路径（@ 提及会话引用用）。 */
  async listWithPaths(projectId: string): Promise<SessionMentionCandidate[]> {
    return (await this.workers.listWithPaths(projectId))
      .map((thread) => ({ ...thread, archived: this.projects.isArchived(projectId, thread.id) }))
      .filter((thread) => !thread.archived);
  }

  async getDraftConfig(projectId: string, worktreePath?: string): Promise<DraftSessionConfig> {
    const cwd = worktreePath
      ? await this.projects.resolveSessionCwd(projectId, worktreePath)
      : this.projects.getCwd(projectId);
    return this.workers.getDraftConfig(projectId, cwd);
  }

  getExtensionState(projectId: string, threadId: string) {
    return this.workers.getExtensionState(projectId, threadId);
  }

  extensionSettingsChanged(): Promise<void> {
    return this.workers.extensionSettingsChanged();
  }

  prewarm(projectId: string, threadId: string): Promise<void> {
    return this.workers.prewarm(projectId, threadId);
  }

  /** 关闭指定 renderer 的 leases，并在没有其他消费者时退役已完成 thread 的 worker。 */
  async close(ownerId: number, projectId: string, threadId: string): Promise<void> {
    this.clearOwnerPendingAttachments(ownerId, projectId, threadId);
    this.clearOwnerSessionSubscriptions(ownerId, projectId, threadId);
    await this.workers.close(projectId, threadId);
  }

  async create(input: SessionCreateInput): Promise<SessionBootstrap> {
    const worktreePath = input.worktreePath
      ? await this.projects.resolveWorktree(input.projectId, input.worktreePath)
      : undefined;
    return this.workers.create({ ...input, ...(worktreePath ? { worktreePath } : {}) });
  }

  async attach(
    ownerId: number,
    input: SessionAttachInput,
    send: (update: SessionPush) => void,
  ): Promise<SessionAttachment> {
    const { projectId, threadId, requestId, replaceAttachmentId } = input;
    const pending = this.pendingFor(ownerId);
    if (pending.has(requestId)) throw new Error(`Duplicate session attachment request: ${requestId}`);

    const existing = this.findSubscription(ownerId, projectId, threadId);
    if (!replaceAttachmentId && existing) throw new Error(`Session already attached: ${projectId}/${threadId}`);
    if (replaceAttachmentId) {
      const replacement = this.subscriptionFor(ownerId, replaceAttachmentId);
      if (!replacement || replacement.projectId !== projectId || replacement.threadId !== threadId) {
        throw new Error("Stale session attachment replacement token");
      }
    }

    const attachmentId = randomUUID();
    const subscription: RendererSubscription = {
      attachmentId,
      projectId,
      threadId,
      send,
      pendingEvents: 0,
      pendingBytes: 0,
      resyncing: false,
    };
    pending.set(requestId, { projectId, threadId });
    this.subscriptionsFor(ownerId).set(attachmentId, subscription);
    let workerAttached = false;
    try {
      const bootstrap = await this.workers.attach(projectId, threadId);
      workerAttached = true;
      const currentPending = this.pendingAttachments.get(ownerId)?.get(requestId);
      if (!currentPending || currentPending.projectId !== projectId || currentPending.threadId !== threadId) {
        throw new DOMException("Session attach superseded", "AbortError");
      }
      this.pendingAttachments.get(ownerId)?.delete(requestId);

      if (replaceAttachmentId) {
        const replacement = this.subscriptionFor(ownerId, replaceAttachmentId);
        if (!replacement || replacement.projectId !== projectId || replacement.threadId !== threadId) {
          throw new DOMException("Session attachment replacement superseded", "AbortError");
        }
        this.detachSubscription(ownerId, replaceAttachmentId);
      }

      return { protocolVersion: bootstrap.protocolVersion, attachmentId, bootstrap };
    } catch (error) {
      this.pendingAttachments.get(ownerId)?.delete(requestId);
      const subscriptions = this.subscriptions.get(ownerId);
      if (subscriptions?.get(attachmentId) === subscription) {
        subscriptions.delete(attachmentId);
        if (subscriptions.size === 0) this.subscriptions.delete(ownerId);
        this.releaseAttachmentAcks(ownerId, attachmentId);
      }
      if (workerAttached) this.workers.detach(projectId, threadId);
      throw error;
    }
  }

  prompt(input: SessionPromptInput): Promise<SessionCommandResult> {
    return this.workers.prompt(input);
  }

  edit(input: SessionEditInput): Promise<SessionCommandResult> {
    return this.workers.edit(input);
  }

  reload(input: SessionReloadInput): Promise<SessionCommandResult> {
    return this.workers.reload(input);
  }

  reloadResources(input: SessionResourceReloadInput): Promise<SessionCommandResult> {
    return this.workers.reloadResources(input);
  }

  getCheckpointDiff(input: SessionCheckpointDiffInput): Promise<SessionCheckpointDiffResult> {
    return this.workers.getCheckpointDiff(input);
  }

  restoreCheckpoint(input: SessionCheckpointRestoreInput): Promise<SessionCheckpointRestoreResult> {
    return this.workers.restoreCheckpoint(input);
  }

  branch(input: SessionBranchInput): Promise<SessionBranchResult> {
    return this.workers.branch(input);
  }

  cancel(projectId: string, threadId: string): Promise<ClearedQueue> {
    return this.workers.cancel(projectId, threadId);
  }

  clearQueue(projectId: string, threadId: string): Promise<ClearedQueue> {
    return this.workers.clearQueue(projectId, threadId);
  }

  compact(projectId: string, threadId: string): Promise<void> {
    return this.workers.compact(projectId, threadId);
  }

  refreshModels(projectId: string, threadId: string): Promise<void> {
    return this.workers.refreshModels(projectId, threadId);
  }

  setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void> {
    return this.workers.setModel(projectId, threadId, provider, modelId);
  }

  setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void> {
    return this.workers.setThinking(projectId, threadId, level);
  }

  applyExtensionSet(projectId: string, threadId: string, expectedDesiredGeneration: string, abortRunning = false) {
    return this.workers.applyExtensionSet(projectId, threadId, expectedDesiredGeneration, abortRunning);
  }

  getSessionPluginOptions(projectId: string, threadId: string) {
    return this.workers.getSessionPluginOptions(projectId, threadId);
  }

  applySessionPluginSelection(
    projectId: string,
    threadId: string,
    enabledPluginIds: string[] | null,
    abortRunning = false,
  ) {
    return this.workers.applySessionPluginSelection(projectId, threadId, enabledPluginIds, abortRunning);
  }

  rename(projectId: string, threadId: string, title: string): Promise<void> {
    return this.workers.rename(projectId, threadId, title);
  }

  async archive(projectId: string, threadId: string, archived: boolean): Promise<void> {
    await this.projects.setArchived(projectId, threadId, archived);
    if (archived) {
      this.clearPendingAttachments(projectId, threadId);
      this.clearSessionSubscriptions(projectId, threadId);
    }
  }

  promote(projectId: string, threadId: string): Promise<SessionRemoveResult> {
    return this.workers.promote(projectId, threadId);
  }

  async remove(projectId: string, threadId: string, policy: SessionRemovePolicy): Promise<SessionRemoveResult> {
    this.clearPendingAttachments(projectId, threadId);
    this.clearSessionSubscriptions(projectId, threadId);
    const result = await this.workers.remove(projectId, threadId, policy);
    for (const removedThreadId of result.removedThreadIds) {
      this.clearPendingAttachments(projectId, removedThreadId);
      this.clearSessionSubscriptions(projectId, removedThreadId);
    }
    for (const reparented of result.reparentedThreads) {
      this.clearPendingAttachments(projectId, reparented.id);
      this.clearSessionSubscriptions(projectId, reparented.id);
    }
    const cleanupResults = await Promise.allSettled(
      result.removedThreadIds.map((removedThreadId) => this.projects.removeWorkbench(projectId, removedThreadId)),
    );
    cleanupResults.forEach((cleanupResult, index) => {
      if (cleanupResult.status !== "rejected") return;
      this.log?.(
        "session-remove",
        `Failed to remove workbench for ${projectId}/${result.removedThreadIds[index]}: ${
          cleanupResult.reason instanceof Error ? cleanupResult.reason.message : String(cleanupResult.reason)
        }`,
      );
    });
    return result;
  }

  async removeProject(projectId: string): Promise<void> {
    for (const [ownerId, leases] of this.subscriptions) {
      for (const subscription of [...leases.values()]) {
        if (subscription.projectId === projectId) this.detachSubscription(ownerId, subscription.attachmentId);
      }
    }
    await this.workers.removeProject(projectId);
    for (const [ownerId, pending] of this.pendingAttachments) {
      for (const [requestId, attachment] of pending) {
        if (attachment.projectId === projectId) pending.delete(requestId);
      }
      if (pending.size === 0) this.pendingAttachments.delete(ownerId);
    }
  }

  respond(projectId: string, threadId: string, response: HostResponse): Promise<void> {
    return this.workers.respond(projectId, threadId, response);
  }

  /** 在 attachment 租约内读取 timeline 图像资源主体；错误 renderer 或已 detach 的 attachment 无法读取。 */
  async readImageResource(
    ownerId: number,
    attachmentId: string,
    resourceId: string,
  ): Promise<SessionImageResource | undefined> {
    const subscription = this.subscriptionFor(ownerId, attachmentId);
    if (!subscription) throw new Error("Session attachment is not active");
    return this.workers.readImageResource(subscription.projectId, subscription.threadId, resourceId);
  }

  async resolvePluginCallArtifact(ownerId: number, input: OpenPluginCallArtifactInput): Promise<string> {
    if (!this.findSubscription(ownerId, input.projectId, input.threadId)) {
      throw new Error("Session attachment is not active");
    }
    const path = await this.workers.resolvePluginCallArtifact(
      input.projectId,
      input.threadId,
      input.toolCallId,
      input.artifactId,
    );
    if (!path) throw new Error("Plugin call artifact is unavailable");
    return path;
  }

  detach(ownerId: number, attachmentId: string): void {
    const pending = this.pendingAttachments.get(ownerId);
    if (pending?.delete(attachmentId) && pending.size === 0) this.pendingAttachments.delete(ownerId);
    this.detachSubscription(ownerId, attachmentId);
  }

  detachAll(ownerId: number): void {
    for (const attachmentId of [...(this.subscriptions.get(ownerId)?.keys() ?? [])]) {
      this.detachSubscription(ownerId, attachmentId);
    }
    this.pendingAttachments.delete(ownerId);
  }

  acknowledge(ownerId: number, attachmentId: string, workerInstanceId: string, sidecarSequence: number): void {
    if (!this.subscriptionFor(ownerId, attachmentId)) return;
    const key = deliveryKey(workerInstanceId, sidecarSequence);
    const pending = this.pendingDeliveryAcks.get(key);
    if (!pending) return;
    this.releaseConsumerAck(consumerKey(ownerId, attachmentId), pending, key);
  }

  workerFailed(projectId: string, threadId: string, error: Error): void {
    this.publishRuntimeUnavailable(projectId, threadId, error.message, true);
  }

  resyncRequired(projectId: string, threadId: string, reason: string): void {
    this.publishRuntimeRecovering(projectId, threadId, reason);
  }

  receive(update: SessionPushPayload, workerInstanceId: string, sidecarSequence: number): void {
    const consumerIds = new Set<string>();
    const consumerBytes = new Map<string, number>();
    let deliveryTemplate: SessionPush | undefined;
    let deliveryTemplateBytes = 0;
    for (const [ownerId, leases] of this.subscriptions) {
      for (const subscription of leases.values()) {
        if (
          subscription.projectId !== update.projectId ||
          subscription.threadId !== update.threadId ||
          subscription.resyncing
        )
          continue;
        const consumerId = consumerKey(ownerId, subscription.attachmentId);
        if (!deliveryTemplate) {
          const deliveredUpdate =
            update.type === "control"
              ? {
                  ...update,
                  control: {
                    ...update.control,
                    hostRequests: update.control.hostRequests.map((request) => ({ ...request, workerInstanceId })),
                  },
                }
              : update;
          deliveryTemplate = {
            ...deliveredUpdate,
            attachmentId: "",
            workerInstanceId,
            sidecarSequence,
          };
          deliveryTemplateBytes = estimateDeliveryBytes(deliveryTemplate);
        }
        const delivered: SessionPush = {
          ...deliveryTemplate,
          attachmentId: subscription.attachmentId,
        };
        const bytes = deliveryTemplateBytes + subscription.attachmentId.length * 2;
        if (
          subscription.pendingEvents >= MAX_ATTACHMENT_PENDING_EVENTS ||
          subscription.pendingBytes + bytes > MAX_ATTACHMENT_PENDING_BYTES
        ) {
          this.markAttachmentResync(ownerId, subscription, "renderer-delivery-queue-overflow");
          continue;
        }
        try {
          subscription.send(delivered);
        } catch {
          this.markAttachmentResync(ownerId, subscription, "renderer-delivery-failed");
          continue;
        }
        subscription.pendingEvents += 1;
        subscription.pendingBytes += bytes;
        consumerIds.add(consumerId);
        consumerBytes.set(consumerId, bytes);
      }
    }
    if (consumerIds.size === 0) {
      this.workers.acknowledge(workerInstanceId, sidecarSequence);
      return;
    }
    const key = deliveryKey(workerInstanceId, sidecarSequence);
    this.pendingDeliveryAcks.set(key, {
      workerInstanceId,
      sidecarSequence,
      consumerIds,
      consumerBytes,
      timer: setTimeout(
        () => this.handleDeliveryAckTimeout(workerInstanceId, sidecarSequence),
        DELIVERY_ACK_TIMEOUT_MS,
      ),
    });
  }

  dispose(): Promise<void> {
    for (const pending of this.pendingDeliveryAcks.values()) {
      clearTimeout(pending.timer);
      this.workers.acknowledge(pending.workerInstanceId, pending.sidecarSequence);
    }
    this.pendingDeliveryAcks.clear();
    this.subscriptions.clear();
    this.pendingAttachments.clear();
    return this.workers.dispose();
  }

  private subscriptionsFor(ownerId: number): Map<string, RendererSubscription> {
    let subscriptions = this.subscriptions.get(ownerId);
    if (!subscriptions) {
      subscriptions = new Map();
      this.subscriptions.set(ownerId, subscriptions);
    }
    return subscriptions;
  }

  private pendingFor(ownerId: number): Map<string, PendingRendererAttachment> {
    let pending = this.pendingAttachments.get(ownerId);
    if (!pending) {
      pending = new Map();
      this.pendingAttachments.set(ownerId, pending);
    }
    return pending;
  }

  private subscriptionFor(ownerId: number, attachmentId: string): RendererSubscription | undefined {
    return this.subscriptions.get(ownerId)?.get(attachmentId);
  }

  private findSubscription(ownerId: number, projectId: string, threadId: string): RendererSubscription | undefined {
    return [...(this.subscriptions.get(ownerId)?.values() ?? [])].find(
      (subscription) => subscription.projectId === projectId && subscription.threadId === threadId,
    );
  }

  private detachSubscription(ownerId: number, attachmentId: string): void {
    const leases = this.subscriptions.get(ownerId);
    const subscription = leases?.get(attachmentId);
    if (!subscription) return;
    leases?.delete(attachmentId);
    if (leases?.size === 0) this.subscriptions.delete(ownerId);
    this.workers.detach(subscription.projectId, subscription.threadId);
    this.releaseAttachmentAcks(ownerId, attachmentId);
  }

  private publishRuntimeUnavailable(projectId: string, threadId: string, error: string, unknownOutcome: boolean): void {
    this.runtimeStatusSequence += 1;
    this.forEachMatchingSubscription(projectId, threadId, (ownerId, subscription) => {
      if (!subscription.resyncing)
        this.sendControl(ownerId, subscription, {
          type: "runtime-availability",
          projectId,
          threadId,
          availability: { state: "unavailable", error, unknownOutcome },
        });
    });
  }

  private publishRuntimeRecovering(projectId: string, threadId: string, reason: string): void {
    this.runtimeStatusSequence += 1;
    this.forEachMatchingSubscription(projectId, threadId, (ownerId, subscription) => {
      if (!subscription.resyncing)
        this.sendControl(ownerId, subscription, {
          type: "runtime-availability",
          projectId,
          threadId,
          availability: { state: "recovering", reason, unknownOutcome: false },
        });
    });
  }

  private clearOwnerSessionSubscriptions(ownerId: number, projectId: string, threadId: string): void {
    const leases = this.subscriptions.get(ownerId);
    if (!leases) return;
    for (const subscription of [...leases.values()]) {
      if (subscription.projectId === projectId && subscription.threadId === threadId)
        this.detachSubscription(ownerId, subscription.attachmentId);
    }
  }

  private clearOwnerPendingAttachments(ownerId: number, projectId: string, threadId: string): void {
    const pending = this.pendingAttachments.get(ownerId);
    if (!pending) return;
    for (const [requestId, attachment] of pending) {
      if (attachment.projectId === projectId && attachment.threadId === threadId) pending.delete(requestId);
    }
    if (pending.size === 0) this.pendingAttachments.delete(ownerId);
  }

  private clearSessionSubscriptions(projectId: string, threadId: string): void {
    for (const [ownerId, leases] of this.subscriptions) {
      for (const subscription of [...leases.values()]) {
        if (subscription.projectId === projectId && subscription.threadId === threadId)
          this.detachSubscription(ownerId, subscription.attachmentId);
      }
    }
  }

  private clearPendingAttachments(projectId: string, threadId: string): void {
    for (const [ownerId, pending] of this.pendingAttachments) {
      for (const [requestId, attachment] of pending) {
        if (attachment.projectId === projectId && attachment.threadId === threadId) pending.delete(requestId);
      }
      if (pending.size === 0) this.pendingAttachments.delete(ownerId);
    }
  }

  private forEachMatchingSubscription(
    projectId: string,
    threadId: string,
    callback: (ownerId: number, subscription: RendererSubscription) => void,
  ): void {
    for (const [ownerId, leases] of this.subscriptions) {
      for (const subscription of leases.values()) {
        if (subscription.projectId === projectId && subscription.threadId === threadId) callback(ownerId, subscription);
      }
    }
  }

  private releaseAttachmentAcks(ownerId: number, attachmentId: string): void {
    const consumerId = consumerKey(ownerId, attachmentId);
    for (const [key, pending] of this.pendingDeliveryAcks) this.releaseConsumerAck(consumerId, pending, key);
  }

  private releaseConsumerAck(consumerId: string, pending: PendingDeliveryAck, key: string): void {
    if (!pending.consumerIds.delete(consumerId)) return;
    const bytes = pending.consumerBytes.get(consumerId) ?? 0;
    pending.consumerBytes.delete(consumerId);
    const [ownerId, attachmentId] = parseConsumerKey(consumerId);
    const subscription =
      ownerId === null || attachmentId === null ? undefined : this.subscriptionFor(ownerId, attachmentId);
    if (subscription) {
      subscription.pendingEvents = Math.max(0, subscription.pendingEvents - 1);
      subscription.pendingBytes = Math.max(0, subscription.pendingBytes - bytes);
    }
    if (pending.consumerIds.size === 0) {
      clearTimeout(pending.timer);
      this.pendingDeliveryAcks.delete(key);
      this.workers.acknowledge(pending.workerInstanceId, pending.sidecarSequence);
    }
  }

  private handleDeliveryAckTimeout(workerInstanceId: string, sidecarSequence: number): void {
    const key = deliveryKey(workerInstanceId, sidecarSequence);
    const pending = this.pendingDeliveryAcks.get(key);
    if (!pending) return;
    this.log?.(
      "renderer",
      `Delivery ACK timeout: worker=${workerInstanceId}, sequence=${sidecarSequence}, leases=${pending.consumerIds.size}`,
    );
    for (const consumerId of [...pending.consumerIds]) {
      const [ownerId, attachmentId] = parseConsumerKey(consumerId);
      const subscription =
        ownerId === null || attachmentId === null ? undefined : this.subscriptionFor(ownerId, attachmentId);
      if (subscription && ownerId !== null)
        this.markAttachmentResync(ownerId, subscription, "renderer-delivery-ack-timeout");
      else this.releaseConsumerAck(consumerId, pending, key);
    }
  }

  private markAttachmentResync(ownerId: number, subscription: RendererSubscription, reason: string): void {
    if (subscription.resyncing) return;
    this.log?.(
      "renderer",
      `Attachment recovery: attachment=${subscription.attachmentId}, project=${subscription.projectId}, thread=${subscription.threadId}, reason=${reason}, pendingEvents=${subscription.pendingEvents}, pendingBytes=${subscription.pendingBytes}`,
    );
    subscription.resyncing = true;
    this.releaseAttachmentAcks(ownerId, subscription.attachmentId);
    this.runtimeStatusSequence += 1;
    this.sendControl(ownerId, subscription, {
      type: "runtime-availability",
      projectId: subscription.projectId,
      threadId: subscription.threadId,
      availability: { state: "recovering", reason, unknownOutcome: false },
    });
  }

  private sendControl(_ownerId: number, subscription: RendererSubscription, payload: SessionPushPayload): void {
    try {
      subscription.send({
        ...payload,
        attachmentId: subscription.attachmentId,
        workerInstanceId: "desktop-main",
        sidecarSequence: this.runtimeStatusSequence,
      });
    } catch {
      // The renderer is already unavailable; cleanup releases this lease's state.
    }
  }
}

function consumerKey(ownerId: number, attachmentId: string): string {
  return `${ownerId}\u0000${attachmentId}`;
}

function parseConsumerKey(key: string): [number | null, string | null] {
  const separator = key.indexOf("\u0000");
  if (separator === -1) return [null, null];
  const ownerId = Number(key.slice(0, separator));
  return Number.isSafeInteger(ownerId) ? [ownerId, key.slice(separator + 1)] : [null, null];
}

function deliveryKey(workerInstanceId: string, sidecarSequence: number): string {
  return `${workerInstanceId}\u0000${sidecarSequence}`;
}

function estimateDeliveryBytes(update: SessionPush | SessionPushPayload): number {
  return JSON.stringify(update).length * 2;
}
