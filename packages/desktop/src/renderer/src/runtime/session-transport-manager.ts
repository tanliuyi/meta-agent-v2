import type { SessionAttachment, SessionBootstrap, SessionPushPayload } from "../../../shared/contracts.ts";
import {
  type CachedSessionRecord,
  type SessionConnectionState,
  type SessionIdentity,
  sessionRecordKey,
} from "./pi-session-store.ts";

interface CommittedAttachment {
  attachmentId: string;
  generation: number;
}

interface KeyState {
  record: CachedSessionRecord;
  pending: Promise<SessionAttachment> | null;
  committed: CommittedAttachment | null;
  tombstoned: boolean;
}

/**
 * Window-level owner of every renderer attachment lease.
 * A key's lifecycle is serialized without coupling independent cached sessions.
 */
export class SessionTransportManager {
  private readonly keyStates = new Map<string, KeyState>();

  async ensure(record: CachedSessionRecord): Promise<SessionAttachment> {
    const key = record.key;
    let state = this.keyStates.get(key);
    if (!state) {
      state = { record, pending: null, committed: null, tombstoned: false };
      this.keyStates.set(key, state);
    }
    if (state.record !== record || state.tombstoned) throw new Error(`Session record ${key} is retired`);
    if (state.committed?.generation === record.generation) {
      return this.attachmentFromState(record, state.committed);
    }
    if (state.pending) return state.pending;
    return this.startAttach(state, undefined);
  }

  async resync(record: CachedSessionRecord): Promise<SessionAttachment> {
    const state = this.keyStates.get(record.key);
    if (!state || state.record !== record || state.tombstoned)
      throw new Error(`Session record ${record.key} is retired`);
    if (state.pending) return state.pending;
    record.stores.connection.setState("recovering");
    record.stores.summary.set({ connectionState: "recovering" });
    return this.startAttach(state, state.committed?.attachmentId);
  }

  async retire(key: string): Promise<void> {
    const state = this.keyStates.get(key);
    if (!state) return;
    state.tombstoned = true;
    state.record.generation += 1;
    state.record.stores.connection.setState("error");
    state.record.stores.summary.set({ connectionState: "error" });
    const attachmentId = state.committed?.attachmentId;
    state.committed = null;
    this.keyStates.delete(key);
    if (attachmentId) window.desktop.sessions.detach(attachmentId);
    try {
      await state.pending;
    } catch {
      // A retiring record intentionally invalidates any in-flight attach.
    }
  }

  async retireProject(projectId: string): Promise<void> {
    await Promise.all(
      [...this.keyStates.values()]
        .filter((state) => state.record.identity.projectId === projectId)
        .map((state) => this.retire(state.record.key)),
    );
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.keyStates.keys()].map((key) => this.retire(key)));
  }

  getConnectionState(key: string): SessionConnectionState | null {
    const state = this.keyStates.get(key);
    if (!state || state.tombstoned) return null;
    return state.record.stores.connection.getSnapshot();
  }

  hasCommittedLease(record: CachedSessionRecord): boolean {
    const committed = this.keyStates.get(record.key)?.committed;
    return Boolean(committed && committed.generation === record.generation);
  }

  getCommittedAttachmentId(record: CachedSessionRecord): string | null {
    const committed = this.keyStates.get(record.key)?.committed;
    return committed?.generation === record.generation ? committed.attachmentId : null;
  }

  private startAttach(state: KeyState, replaceAttachmentId: string | undefined): Promise<SessionAttachment> {
    const record = state.record;
    const generation = record.generation;
    record.stores.connection.setState(replaceAttachmentId ? "recovering" : "attaching");
    record.stores.summary.set({ connectionState: replaceAttachmentId ? "recovering" : "attaching" });
    const requestId = crypto.randomUUID();
    let attachmentId: string | null = null;
    const pending = (async () => {
      try {
        const attachment = await window.desktop.sessions.attach(
          {
            projectId: record.identity.projectId,
            threadId: record.identity.threadId,
            requestId,
            ...(replaceAttachmentId ? { replaceAttachmentId } : {}),
          },
          (update) => {
            if (attachmentId) this.handlePush(record.key, record, generation, attachmentId, update);
          },
        );
        attachmentId = attachment.attachmentId;
        if (
          state.tombstoned ||
          this.keyStates.get(record.key) !== state ||
          state.record !== record ||
          record.generation !== generation
        ) {
          throw new DOMException("Session attach superseded", "AbortError");
        }

        const workbench = await window.desktop.workbench.get(record.identity.projectId, record.identity.threadId);
        if (
          state.tombstoned ||
          this.keyStates.get(record.key) !== state ||
          state.record !== record ||
          record.generation !== generation
        ) {
          throw new DOMException("Session attach superseded", "AbortError");
        }

        this.commitBootstrap(record, attachment.bootstrap, workbench);
        state.committed = { attachmentId: attachment.attachmentId, generation };
        record.stores.connection.setState("ready");
        record.stores.summary.set({ connectionState: "ready" });
        const flush = window.desktop.sessions.flush(attachment.attachmentId);
        if (flush.state === "recovering") {
          record.stores.connection.setState("recovering");
          record.stores.summary.set({ connectionState: "recovering" });
          queueMicrotask(() => void this.resync(record).catch(() => undefined));
        }
        return attachment;
      } catch (error) {
        if (attachmentId) {
          window.desktop.sessions.detach(attachmentId);
          if (state.committed?.attachmentId === attachmentId || state.committed?.attachmentId === replaceAttachmentId) {
            state.committed = null;
          }
        }
        if (!state.tombstoned && this.keyStates.get(record.key) === state && state.record === record) {
          record.stores.connection.setState("error");
          record.stores.summary.set({ connectionState: "error" });
        }
        throw error;
      }
    })();
    state.pending = pending;
    void pending
      .finally(() => {
        if (state.pending === pending) state.pending = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private attachmentFromState(record: CachedSessionRecord, committed: CommittedAttachment): SessionAttachment {
    const control = record.stores.control.getSnapshot();
    return {
      protocolVersion: record.stores.timeline.getSnapshot().protocolVersion,
      attachmentId: committed.attachmentId,
      bootstrap: {
        protocolVersion: record.stores.timeline.getSnapshot().protocolVersion,
        projectId: record.identity.projectId,
        threadId: record.identity.threadId,
        timeline: record.stores.timeline.getSnapshot(),
        control: control ?? throwMissingControl(record.identity),
      },
    };
  }

  private commitBootstrap(
    record: CachedSessionRecord,
    bootstrap: SessionBootstrap,
    workbench: Awaited<ReturnType<typeof window.desktop.workbench.get>>,
  ): void {
    if (bootstrap.projectId !== record.identity.projectId || bootstrap.threadId !== record.identity.threadId) {
      throw new Error("Session bootstrap identity does not match cache record");
    }
    record.stores.timeline.replace(bootstrap.timeline);
    record.stores.control.replace(bootstrap.control);
    record.stores.workbench.replace(workbench);
    record.stores.summary.set({
      running: bootstrap.timeline.phase === "running" || bootstrap.timeline.phase === "retrying",
      loading: bootstrap.timeline.phase === "compacting" || bootstrap.timeline.phase === "tree-navigation",
    });
  }

  private handlePush(
    key: string,
    record: CachedSessionRecord,
    generation: number,
    attachmentId: string,
    update: SessionPushPayload,
  ): void {
    const state = this.keyStates.get(key);
    if (
      !state ||
      state.tombstoned ||
      state.record !== record ||
      record.generation !== generation ||
      state.committed?.attachmentId !== attachmentId ||
      state.committed.generation !== generation ||
      update.projectId !== record.identity.projectId ||
      update.threadId !== record.identity.threadId
    )
      return;

    if (update.type === "control") {
      record.stores.control.apply(update.control);
      record.stores.summary.set({ running: update.control.running });
      return;
    }
    if (update.type === "runtime-availability") {
      if (update.availability.state === "ready") {
        record.stores.connection.setState("ready");
        record.stores.summary.set({ connectionState: "ready" });
      } else {
        record.stores.connection.setState("recovering");
        record.stores.summary.set({ connectionState: "recovering" });
        void this.resync(record).catch(() => undefined);
      }
      return;
    }
    try {
      record.stores.timeline.apply(update.batch);
      const snapshot = record.stores.timeline.getSnapshot();
      record.stores.summary.set({
        running: snapshot.phase === "running" || snapshot.phase === "retrying",
        loading: snapshot.phase === "compacting" || snapshot.phase === "tree-navigation",
      });
    } catch {
      record.stores.connection.setState("recovering");
      record.stores.summary.set({ connectionState: "recovering" });
      void this.resync(record).catch(() => undefined);
    }
  }
}

function throwMissingControl(identity: SessionIdentity): never {
  throw new Error(`Session ${sessionRecordKey(identity.projectId, identity.threadId)} is missing control state`);
}
