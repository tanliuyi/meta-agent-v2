import { useCallback, useSyncExternalStore } from "react";

const CLOCK_INTERVAL_MS = 60_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function getSnapshot(): number {
  return now;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const current of listeners) current();
    }, CLOCK_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** 为所有可见相对时间共享一个时钟；没有消费者时不保留 timer。 */
export function useSharedClock<T>(selector: (currentTime: number) => T): T {
  const getSelectedSnapshot = useCallback(() => selector(getSnapshot()), [selector]);
  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
}
