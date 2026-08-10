import {
  type AssistantRuntime,
  type Attachment,
  type ExternalStoreAdapter,
  type ExternalThreadQueueAdapter,
  type QueueItemState,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { PiQueueItem, SessionControlState } from "../../../shared/contracts.ts";
import { useExternalStoreSelector } from "../shared/hooks/use-external-store-selector.ts";
import { useToast } from "../shared/ui/use-toast.ts";
import { imageAttachmentAdapter, restoreComposerAttachments } from "./image-attachments.ts";
import { PiCommandCoordinator, resolveReloadUserEntry } from "./pi-command-coordinator.ts";
import { PiMessageRepositoryConverter } from "./pi-message-repository.ts";
import type { CachedSessionRecord } from "./pi-session-store.ts";
import type { SessionTransportManager } from "./session-transport-manager.ts";

interface PiSessionRuntimeOptions {
  record: CachedSessionRecord;
  active: boolean;
  transport: SessionTransportManager;
}

export interface PiSessionRuntimeBinding {
  runtime: AssistantRuntime;
  clearQueue(): Promise<void>;
}

/** Creates the one assistant-ui runtime owned by a cached session activity. */
export function usePiSessionRuntime({ record, active, transport }: PiSessionRuntimeOptions): PiSessionRuntimeBinding {
  const stores = record.stores;
  const { notify, update } = useToast();
  const snapshot = useSyncExternalStore(
    stores.timeline.subscribe,
    stores.timeline.getSnapshot,
    stores.timeline.getSnapshot,
  );
  const readiness = useExternalStoreSelector(stores.control, selectReadiness);
  const controlRunning = useExternalStoreSelector(stores.control, selectRunning);
  const connection = useSyncExternalStore(
    stores.connection.subscribe,
    stores.connection.getSnapshot,
    stores.connection.getSnapshot,
  );
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const converter = useMemo(() => new PiMessageRepositoryConverter(), []);
  const repository = useMemo(() => converter.build(snapshot), [converter, snapshot]);

  const coordinator = useMemo(
    () =>
      new PiCommandCoordinator({
        getTarget: () => {
          if (!activeRef.current || stores.connection.getSnapshot() !== "ready" || !transport.hasCommittedLease(record))
            return null;
          return {
            projectId: record.identity.projectId,
            threadId: record.identity.threadId,
            generation: record.generation,
          };
        },
        getComposer: () => runtimeRef.current?.thread.composer ?? null,
        getPhase: () => snapshotRef.current.phase,
        resolveReloadTarget: (parentId) => resolveReloadUserEntry(snapshotRef.current, parentId),
        notify,
        updateNotification: update,
        report: (error) => console.error("Pi command failed", error),
      }),
    [notify, record, stores.connection, transport, update],
  );

  useEffect(() => coordinator.observeQueue(snapshot.queue), [coordinator, snapshot.queue]);

  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: snapshot.queue.filter(({ mode }) => mode !== "steer").map(toQueueItemState),
      steerItems: snapshot.queue.filter(({ mode }) => mode === "steer").map(toQueueItemState),
      enqueue: coordinator.enqueue,
      steer: coordinator.steer,
      move: coordinator.unsupportedQueueOperation,
      edit: coordinator.unsupportedQueueOperation,
      remove: coordinator.unsupportedQueueOperation,
    }),
    [coordinator, snapshot.queue],
  );

  const isLoading = snapshot.phase === "compacting" || snapshot.phase === "tree-navigation";
  const isAgentRunning =
    !isLoading && (controlRunning || snapshot.phase === "running" || snapshot.phase === "retrying");
  const isCancelable = controlRunning || snapshot.phase !== "idle";
  const acceptsInput = snapshot.phase === "idle" || snapshot.phase === "running";
  const hasCommandTarget = active && connection === "ready" && transport.hasCommittedLease(record);
  const isSendDisabled = !hasCommandTarget || !acceptsInput || readiness?.state !== "ready";
  const runtimeAdapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      messageRepository: repository,
      isRunning: isAgentRunning,
      isLoading,
      isSendDisabled,
      onNew: coordinator.rejectUnexpectedOnNew,
      queue,
      onEdit:
        active && (snapshot.phase === "idle" || snapshot.phase === "running") && !isSendDisabled
          ? (message) => coordinator.edit(message, snapshotRef.current.queue, isAgentRunning)
          : undefined,
      onReload: active && snapshot.phase === "idle" && !isSendDisabled ? coordinator.reload : undefined,
      onCancel: hasCommandTarget && isCancelable ? () => coordinator.cancel(snapshotRef.current.queue) : undefined,
      adapters: { attachments: !isSendDisabled ? imageAttachmentAdapter : undefined },
      unstable_enableToolInvocations: false,
    }),
    [
      active,
      coordinator,
      hasCommandTarget,
      isAgentRunning,
      isCancelable,
      isLoading,
      isSendDisabled,
      queue,
      repository,
      snapshot.phase,
    ],
  );
  const runtime = useExternalStoreRuntime<ThreadMessage>(runtimeAdapter);
  const composer = runtime.thread.composer;
  const restoredDraftRef = useRef<{
    composer: typeof composer;
    store: typeof stores.composerDraft;
    savedAttachments: readonly Attachment[];
    restoredAttachments: Set<Attachment>;
    restorePromise: Promise<void> | null;
    complete: boolean;
  } | null>(null);
  runtimeRef.current = runtime;

  useEffect(() => {
    const savedDraft = stores.composerDraft.getSnapshot();
    let restoreState = restoredDraftRef.current;
    if (restoreState?.composer !== composer || restoreState.store !== stores.composerDraft) {
      restoreState = {
        composer,
        store: stores.composerDraft,
        savedAttachments: savedDraft.attachments,
        restoredAttachments: new Set(),
        restorePromise: null,
        complete: savedDraft.attachments.length === 0,
      };
      restoredDraftRef.current = restoreState;
    }
    composer.setText(savedDraft.text);

    const syncDraft = () => {
      const state = composer.getState();
      stores.composerDraft.setSnapshot({
        text: state.text,
        attachments: restoreState.complete ? state.attachments : restoreState.savedAttachments,
      });
    };
    const unsubscribe = composer.subscribe(syncDraft);
    syncDraft();

    if (!isSendDisabled && !restoreState.complete && !restoreState.restorePromise) {
      const currentRestore = restoreState;
      currentRestore.restorePromise = restoreComposerAttachments(
        (attachment) => composer.addAttachment(attachment),
        currentRestore.savedAttachments,
        currentRestore.restoredAttachments,
      );
      void currentRestore.restorePromise.then(
        () => {
          currentRestore.complete = true;
          currentRestore.restorePromise = null;
          if (restoredDraftRef.current === currentRestore) syncDraft();
        },
        (error: unknown) => {
          currentRestore.restorePromise = null;
          console.error("Unable to restore composer attachments", error);
        },
      );
    }

    return () => {
      unsubscribe();
      syncDraft();
    };
  }, [composer, isSendDisabled, stores.composerDraft]);

  const clearQueue = useCallback(() => coordinator.clearQueue(snapshotRef.current.queue), [coordinator]);
  return useMemo(() => ({ runtime, clearQueue }), [clearQueue, runtime]);
}

function toQueueItemState({ id, prompt }: PiQueueItem): QueueItemState {
  return { id, prompt, parts: [{ type: "text", text: prompt }] };
}

function selectReadiness(control: SessionControlState | null): SessionControlState["readiness"] | undefined {
  return control?.readiness;
}

function selectRunning(control: SessionControlState | null): boolean {
  return control?.running === true;
}
