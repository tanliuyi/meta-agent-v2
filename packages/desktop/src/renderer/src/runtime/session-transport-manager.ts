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
  resyncAfterPending: boolean;
  tombstoned: boolean;
}

/**
 * key -> 被 detach/retire 中断后仍在收尾的 attach 完成信号。
 * 收尾期间（含主进程 detach IPC 的发出）必须串行化后续 attach，
 * 否则主进程会因残留 subscription 拒绝 "Session already attached"。
 * invalidated 表示 retire 已使等待该收尾的排队 ensure 失效。
 */
interface SettlingEntry {
  promise: Promise<void>;
  invalidated: boolean;
  /** 收尾所属的 record：只对同一 record 的排队 ensure 生效。 */
  record: CachedSessionRecord;
}

const INITIAL_ATTACH_RETRY_DELAY_MS = 100;

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Window-level owner of every renderer attachment lease.
 * A key's lifecycle is serialized without coupling independent cached sessions.
 */
export class SessionTransportManager {
  private readonly keyStates = new Map<string, KeyState>();
  private readonly settling = new Map<string, SettlingEntry>();
  private readonly quiesced = new Map<string, CachedSessionRecord>();

  async ensure(record: CachedSessionRecord): Promise<SessionAttachment> {
    const key = record.key;
    if (this.quiesced.get(key) === record) throw new Error(`Session record ${key} is quiesced`);
    // 前一次 attach 被中断后仍在收尾：等其 abort 清理（含主进程 detach IPC）完成再发起新 attach。
    const settling = this.settling.get(key);
    if (settling) {
      await settling.promise;
      // retire 使等待中的 ensure 失效：已 retire 的 record 不允许重建 attachment。
      if (settling.invalidated && settling.record === record) {
        throw new Error(`Session record ${key} is retired`);
      }
    }
    let state = this.keyStates.get(key);
    if (!state) {
      state = { record, pending: null, committed: null, resyncAfterPending: false, tombstoned: false };
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
    record.stores.connection.setState("recovering");
    record.stores.summary.set({ connectionState: "recovering" });
    if (state.pending) {
      state.resyncAfterPending = true;
      const pending = state.pending;
      try {
        await pending;
      } catch (error) {
        state.resyncAfterPending = false;
        throw error;
      }
      if (this.keyStates.get(record.key) !== state || state.record !== record || state.tombstoned) {
        throw new Error(`Session record ${record.key} is retired`);
      }
      if (!state.resyncAfterPending) return this.ensure(record);
      state.resyncAfterPending = false;
      if (state.pending) return state.pending;
      // 等待期间的 attach 已成功提交租约（ready）：本次 resync 已满足，
      // 直接返回已提交租约，不再发起第二次替换 attach（否则 transport 直接 resync
      // 与 UI 恢复循环并发时会链式产生多个顺序替换 attach）。
      if (record.stores.connection.getSnapshot() === "ready") return this.ensure(record);
    }
    return this.startAttach(state, state.committed?.attachmentId);
  }

  private recordSettling(
    key: string,
    pending: Promise<unknown> | null,
    record: CachedSessionRecord,
    invalidated: boolean,
  ): void {
    const entry: SettlingEntry = {
      invalidated,
      record,
      promise: (async () => {
        try {
          // 被中断的 attach 在其内部收尾时会同步发出 abort detach IPC。
          await pending;
        } catch {
          // Detaching/retiring intentionally invalidates any in-flight attach.
        }
      })(),
    };
    this.settling.set(key, entry);
    void entry.promise.finally(() => {
      if (this.settling.get(key) === entry) this.settling.delete(key);
    });
  }

  async quiesce(record: CachedSessionRecord): Promise<() => Promise<void>> {
    const key = record.key;
    const current = this.quiesced.get(key);
    if (current && current !== record) throw new Error(`Session record ${key} is retired`);
    this.quiesced.set(key, record);
    record.stores.connection.setState("attaching");
    record.stores.summary.set({ connectionState: "attaching" });
    await this.detach(key);
    return async () => {
      if (this.quiesced.get(key) !== record) return;
      this.quiesced.delete(key);
      await this.ensure(record);
    };
  }

  async detach(key: string): Promise<void> {
    const state = this.keyStates.get(key);
    if (!state) return;
    state.tombstoned = true;
    state.resyncAfterPending = false;
    state.record.generation += 1;
    state.record.stores.connection.setState("attaching");
    state.record.stores.summary.set({ connectionState: "attaching" });
    const attachmentId = state.committed?.attachmentId;
    state.committed = null;
    this.keyStates.delete(key);
    if (attachmentId) window.desktop.sessions.detach(attachmentId);
    this.recordSettling(key, state.pending, state.record, false);
    await state.pending?.catch(() => undefined);
  }

  async retire(key: string): Promise<void> {
    this.quiesced.delete(key);
    const state = this.keyStates.get(key);
    if (state) {
      state.tombstoned = true;
      state.resyncAfterPending = false;
      state.record.generation += 1;
      state.record.stores.connection.setState("error");
      state.record.stores.summary.set({ connectionState: "error" });
      const attachmentId = state.committed?.attachmentId;
      state.committed = null;
      this.keyStates.delete(key);
      if (attachmentId) window.desktop.sessions.detach(attachmentId);
      this.recordSettling(key, state.pending, state.record, true);
      await state.pending?.catch(() => undefined);
      return;
    }
    // detach 已移除 keyState 但收尾仍在进行：失效等待中的 ensure，防止为已 retire 的 record 重建 attachment。
    const settling = this.settling.get(key);
    if (settling) {
      settling.invalidated = true;
      await settling.promise;
    }
  }

  async retireProject(projectId: string): Promise<void> {
    const keys = new Set<string>([
      ...[...this.keyStates.values()]
        .filter((state) => state.record.identity.projectId === projectId)
        .map((state) => state.record.key),
      ...[...this.settling.entries()]
        .filter(([, entry]) => entry.record.identity.projectId === projectId)
        .map(([key]) => key),
    ]);
    await Promise.all([...keys].map((key) => this.retire(key)));
  }

  async detachAll(): Promise<void> {
    // 同时覆盖 keyStates、quiesce 与收尾中的 settling：detach 进行中排队的 ensure
    // 也会被失效，避免窗口卸载后仍重建 attachment。
    const keys = new Set<string>([...this.keyStates.keys(), ...this.quiesced.keys(), ...this.settling.keys()]);
    await Promise.all([...keys].map((key) => this.retire(key)));
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

  /**
   * 恢复连接：无已提交租约时走 ensure（复用 in-flight attach 或发起首次 attach）；
   * 有已提交租约时走 resync 替换租约（resync 失败后 committed 仍在，ensure 只会返回旧租约）。
   */
  async recover(record: CachedSessionRecord): Promise<SessionAttachment> {
    const state = this.keyStates.get(record.key);
    if (!state) return this.ensure(record);
    if (state.record !== record || state.tombstoned) throw new Error(`Session record ${record.key} is retired`);
    if (!state.committed || state.committed.generation !== record.generation) return this.ensure(record);
    return this.resync(record);
  }

  private startAttach(state: KeyState, replaceAttachmentId: string | undefined): Promise<SessionAttachment> {
    const record = state.record;
    const generation = record.generation;
    record.stores.connection.setState(replaceAttachmentId ? "recovering" : "attaching");
    record.stores.summary.set({ connectionState: replaceAttachmentId ? "recovering" : "attaching" });
    let attachmentId: string | null = null;
    const pending = (async () => {
      try {
        let attachment: SessionAttachment | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const requestId = crypto.randomUUID();
          try {
            attachment = await window.desktop.sessions.attach(
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
            break;
          } catch (error) {
            const retryInitialAttach =
              attempt === 0 &&
              !replaceAttachmentId &&
              !isAbortError(error) &&
              !state.tombstoned &&
              this.keyStates.get(record.key) === state &&
              state.record === record &&
              record.generation === generation;
            if (!retryInitialAttach) throw error;
            record.stores.connection.setState("recovering");
            record.stores.summary.set({ connectionState: "recovering" });
            await delay(INITIAL_ATTACH_RETRY_DELAY_MS);
            if (
              state.tombstoned ||
              this.keyStates.get(record.key) !== state ||
              state.record !== record ||
              record.generation !== generation
            ) {
              throw new DOMException("Session attach superseded during retry", "AbortError");
            }
          }
        }
        if (!attachment) throw new Error(`Session attach produced no attachment: ${record.key}`);
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
          // 临时性失败以 recovering 呈现，由调用方（SessionContent/主会话）重试恢复，不显示“会话连接失败”。
          record.stores.connection.setState("recovering");
          record.stores.summary.set({ connectionState: "recovering" });
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
    record.stores.runActivity.sync(bootstrap.timeline);
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
      record.stores.runActivity.sync(snapshot);
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
