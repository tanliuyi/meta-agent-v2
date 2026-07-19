import type {
  SessionBootstrap,
  SessionControlState,
  SessionPushPayload,
  SessionRuntimeAvailability,
} from "../../../shared/contracts.ts";
import { detachedSnapshot, PiThreadStore } from "./pi-thread-store.ts";

type ControlListener = (control: SessionControlState) => void;
type ResyncListener = (bootstrap: SessionBootstrap) => void;
type RuntimeListener = (availability: SessionRuntimeAvailability) => void;

interface PendingResync {
  key: string;
  generation: number;
  promise: Promise<SessionBootstrap>;
}

interface RecoveryIntent {
  projectId: string;
  threadId: string;
  key: string;
  generation: number;
}

/** renderer 内单一 active attachment 的 Pi timeline 分发器。 */
export class PiSessionBus {
  readonly store = new PiThreadStore();
  private activeKey = "";
  private readonly controlListeners = new Set<ControlListener>();
  private readonly resyncListeners = new Set<ResyncListener>();
  private readonly runtimeListeners = new Set<RuntimeListener>();
  private latestAttachmentGeneration = 0;
  private committedAttachmentGeneration = 0;
  private readonly bootstrapGenerations = new WeakMap<SessionBootstrap, number>();
  private pendingResync?: PendingResync;
  private recoveryIntent?: RecoveryIntent;
  private recoveryTimer?: number;

  async attach(projectId: string, threadId: string): Promise<SessionBootstrap> {
    const generation = ++this.latestAttachmentGeneration;
    this.cancelRecoveryTimer();
    this.pendingResync = undefined;
    try {
      const bootstrap = await window.desktop.sessions.attach(projectId, threadId, (update) => this.receive(update));
      this.bootstrapGenerations.set(bootstrap, generation);
      return bootstrap;
    } catch (error) {
      if (this.latestAttachmentGeneration === generation) {
        this.latestAttachmentGeneration = this.committedAttachmentGeneration;
        this.scheduleRecovery();
      }
      throw error;
    }
  }

  /** 在 assistant-ui 准备完成后原子提交 active identity、timeline 与 control baseline。 */
  commit(bootstrap: SessionBootstrap): void {
    const preparedGeneration = this.bootstrapGenerations.get(bootstrap);
    const generation = preparedGeneration ?? ++this.latestAttachmentGeneration;
    if (generation !== this.latestAttachmentGeneration) return;
    this.committedAttachmentGeneration = generation;
    this.clearRecovery();
    this.pendingResync = undefined;
    this.activeKey = transportSessionKey(bootstrap.projectId, bootstrap.threadId);
    this.store.replace(bootstrap.timeline);
    for (const listener of this.controlListeners) listener(bootstrap.control);
    for (const listener of this.runtimeListeners) listener({ state: "ready", unknownOutcome: false });
  }

  detach(): void {
    window.desktop.sessions.detach();
    this.latestAttachmentGeneration += 1;
    this.committedAttachmentGeneration = this.latestAttachmentGeneration;
    this.activeKey = "";
    this.pendingResync = undefined;
    this.clearRecovery();
    this.store.replace(detachedSnapshot());
  }

  onControl(listener: ControlListener): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  onResync(listener: ResyncListener): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onRuntime(listener: RuntimeListener): () => void {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  }

  resync(projectId: string, threadId: string): Promise<SessionBootstrap> {
    const key = transportSessionKey(projectId, threadId);
    if (this.pendingResync?.key === key) return this.pendingResync.promise;
    if (this.activeKey !== key || this.latestAttachmentGeneration !== this.committedAttachmentGeneration) {
      return Promise.reject(new DOMException("Session resync superseded", "AbortError"));
    }
    const attachment = this.attach(projectId, threadId);
    const generation = this.latestAttachmentGeneration;
    const promise = attachment.then((bootstrap) => {
      if (this.activeKey !== key || this.latestAttachmentGeneration !== generation) return bootstrap;
      this.commit(bootstrap);
      for (const listener of this.resyncListeners) listener(bootstrap);
      return bootstrap;
    });
    this.pendingResync = { key, generation, promise };
    const clearPending = () => {
      if (this.pendingResync?.promise === promise) this.pendingResync = undefined;
    };
    void promise.then(clearPending, clearPending);
    return promise;
  }

  private receive(update: SessionPushPayload): void {
    if (update.type === "runtime-availability") {
      if (transportSessionKey(update.projectId, update.threadId) !== this.activeKey) return;
      for (const listener of this.runtimeListeners) listener(update.availability);
      if (update.availability.state === "ready") {
        this.clearRecovery();
      } else {
        this.recoveryIntent = {
          projectId: update.projectId,
          threadId: update.threadId,
          key: this.activeKey,
          generation: this.committedAttachmentGeneration,
        };
        this.scheduleRecovery();
      }
      return;
    }
    if (update.type === "control") {
      for (const listener of this.controlListeners) listener(update.control);
      return;
    }
    if (transportSessionKey(update.projectId, update.threadId) !== this.activeKey) return;
    try {
      this.store.apply(update.batch);
    } catch (error) {
      const [projectId, threadId] = splitTransportSessionKey(this.activeKey);
      if (!projectId || !threadId) throw error;
      void this.resync(projectId, threadId).catch((resyncError: unknown) =>
        console.error("Pi timeline resync 失败", resyncError),
      );
    }
  }

  private scheduleRecovery(): void {
    if (!this.recoveryIntent || this.recoveryTimer !== undefined) return;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = undefined;
      const intent = this.recoveryIntent;
      if (
        !intent ||
        this.activeKey !== intent.key ||
        this.latestAttachmentGeneration !== intent.generation ||
        this.committedAttachmentGeneration !== intent.generation
      )
        return;
      void this.resync(intent.projectId, intent.threadId).catch((error: unknown) =>
        console.error("Pi sidecar fresh bootstrap failed", error),
      );
    }, 250);
  }

  private clearRecovery(): void {
    this.recoveryIntent = undefined;
    this.cancelRecoveryTimer();
  }

  private cancelRecoveryTimer(): void {
    if (this.recoveryTimer !== undefined) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }
}

export const piSessionBus = new PiSessionBus();

/** transport identity 使用 NUL 分隔，避免合法 ID 中的冒号与路径字符产生歧义。 */
function transportSessionKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`;
}

function splitTransportSessionKey(key: string): [string, string] {
  const separator = key.indexOf("\u0000");
  return separator === -1 ? ["", ""] : [key.slice(0, separator), key.slice(separator + 1)];
}
