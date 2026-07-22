import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ExternalThreadQueueAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { imageAttachmentAdapter } from "./image-attachments.ts";
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
  const snapshot = useSyncExternalStore(
    stores.timeline.subscribe,
    stores.timeline.getSnapshot,
    stores.timeline.getSnapshot,
  );
  const controlSnapshot = useSyncExternalStore(
    stores.control.subscribe,
    stores.control.getSnapshot,
    stores.control.getSnapshot,
  );
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
        report: (error) => console.error("Pi command failed", error),
      }),
    [record, stores.connection, transport],
  );

  useEffect(() => coordinator.observeQueue(snapshot.queue), [coordinator, snapshot.queue]);

  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: snapshot.queue.map(({ id, prompt }) => ({ id, prompt })),
      enqueue: coordinator.enqueue,
      steer: coordinator.unsupportedQueueOperation,
      remove: coordinator.unsupportedQueueOperation,
      clear: coordinator.observeFrameworkClear,
    }),
    [coordinator, snapshot.queue],
  );

  const readiness = controlSnapshot?.readiness;
  const isLoading = snapshot.phase === "compacting" || snapshot.phase === "tree-navigation";
  const isAgentRunning =
    !isLoading && (controlSnapshot?.running === true || snapshot.phase === "running" || snapshot.phase === "retrying");
  const isCancelable = controlSnapshot?.running === true || snapshot.phase !== "idle";
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
      onEdit: active && snapshot.phase === "idle" && !isSendDisabled ? coordinator.edit : undefined,
      onReload: active && snapshot.phase === "idle" && !isSendDisabled ? coordinator.reload : undefined,
      onCancel: hasCommandTarget && isCancelable ? coordinator.cancel : undefined,
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
  runtimeRef.current = runtime;
  const clearQueue = useCallback(() => coordinator.clearQueue(snapshotRef.current.queue), [coordinator]);
  return useMemo(() => ({ runtime, clearQueue }), [clearQueue, runtime]);
}
