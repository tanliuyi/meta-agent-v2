import { useSyncExternalStore } from "react";
import { piSessionBus } from "./pi-session-bus.ts";

export function usePiThreadPhase() {
  return useSyncExternalStore(
    piSessionBus.store.subscribe,
    () => piSessionBus.store.getSnapshot().phase,
    () => piSessionBus.store.getSnapshot().phase,
  );
}

export function usePiQueueCount() {
  return useSyncExternalStore(
    piSessionBus.store.subscribe,
    () => piSessionBus.store.getSnapshot().queue.length,
    () => piSessionBus.store.getSnapshot().queue.length,
  );
}

export function usePiQueueItems() {
  return useSyncExternalStore(
    piSessionBus.store.subscribe,
    () => piSessionBus.store.getSnapshot().queue,
    () => piSessionBus.store.getSnapshot().queue,
  );
}
