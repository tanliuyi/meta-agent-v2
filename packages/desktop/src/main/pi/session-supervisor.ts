import { randomUUID } from "node:crypto";
import type {
  ClearedQueue,
  DraftSessionConfig,
  HostResponse,
  SessionAttachInput,
  SessionAttachment,
  SessionBootstrap,
  SessionBranchInput,
  SessionBranchResult,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionPromptInput,
  SessionPush,
  SessionPushPayload,
  SessionReloadInput,
  Thread,
} from "../../shared/contracts.ts";
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

  getDraftConfig(projectId: string): Promise<DraftSessionConfig> {
    return this.workers.getDraftConfig(projectId);
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

  create(input: SessionCreateInput): Promise<SessionBootstrap> {
    return this.workers.create(input);
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

    pending.set(requestId, { projectId, threadId });
    try {
      const bootstrap = await this.workers.attach(projectId, threadId);
      const currentPending = this.pendingAttachments.get(ownerId)?.get(requestId);
      if (!currentPending || currentPending.projectId !== projectId || currentPending.threadId !== threadId) {
        this.workers.detach(projectId, threadId);
        throw new DOMException("Session attach superseded", "AbortError");
      }
      this.pendingAttachments.get(ownerId)?.delete(requestId);

      if (replaceAttachmentId) {
        const replacement = this.subscriptionFor(ownerId, replaceAttachmentId);
        if (!replacement || replacement.projectId !== projectId || replacement.threadId !== threadId) {
          this.workers.detach(projectId, threadId);
          throw new DOMException("Session attachment replacement superseded", "AbortError");
        }
        this.detachSubscription(ownerId, replaceAttachmentId);
      } else if (this.findSubscription(ownerId, projectId, threadId)) {
        this.workers.detach(projectId, threadId);
        throw new Error(`Session already attached: ${projectId}/${threadId}`);
      }

      const attachmentId = randomUUID();
      this.subscriptionsFor(ownerId).set(attachmentId, {
        attachmentId,
        projectId,
        threadId,
        send,
        pendingEvents: 0,
        pendingBytes: 0,
        resyncing: false,
      });
      return { protocolVersion: bootstrap.protocolVersion, attachmentId, bootstrap };
    } catch (error) {
      this.pendingAttachments.get(ownerId)?.delete(requestId);
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

  branch(input: SessionBranchInput): Promise<SessionBranchResult> {
    return this.workers.branch(input);
  }

  cancel(projectId: string, threadId: string): Promise<void> {
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

  async remove(projectId: string, threadId: string): Promise<void> {
    this.clearPendingAttachments(projectId, threadId);
    this.clearSessionSubscriptions(projectId, threadId);
    await this.workers.remove(projectId, threadId);
    await this.projects.removeWorkbench(projectId, threadId);
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
    for (const [ownerId, leases] of this.subscriptions) {
      for (const subscription of leases.values()) {
        if (
          subscription.projectId !== update.projectId ||
          subscription.threadId !== update.threadId ||
          subscription.resyncing
        )
          continue;
        const consumerId = consumerKey(ownerId, subscription.attachmentId);
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
        const delivered: SessionPush = {
          ...deliveredUpdate,
          attachmentId: subscription.attachmentId,
          workerInstanceId,
          sidecarSequence,
        };
        const bytes = estimateDeliveryBytes(delivered);
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
