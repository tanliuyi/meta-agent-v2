import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { pinnedThreadKey, readStoredPinnedThreads, writeStoredThreadPinned } from "./thread-pinning-preference.ts";

export const PINNED_THREADS_CHANGED_EVENT = "pi-desktop:pinned-threads-changed";

interface ThreadPinningContextValue {
  pinnedThreadKeys: ReadonlySet<string>;
  toggleThread(projectId: string, threadId: string): void;
}

const EMPTY_PINNED_THREAD_KEYS: ReadonlySet<string> = new Set();
const DEFAULT_CONTEXT: ThreadPinningContextValue = {
  pinnedThreadKeys: EMPTY_PINNED_THREAD_KEYS,
  toggleThread: () => undefined,
};
const ThreadPinningContext = createContext<ThreadPinningContextValue>(DEFAULT_CONTEXT);

/** 在侧栏内共享置顶状态，保证顶部置顶分组与项目列表同步。 */
export function ThreadPinningProvider({ children }: { children: ReactNode }) {
  const [pinnedThreadKeys, setPinnedThreadKeys] = useState<ReadonlySet<string>>(() => readStoredPinnedThreads());

  useEffect(() => {
    const sync = () => setPinnedThreadKeys(readStoredPinnedThreads());
    window.addEventListener(PINNED_THREADS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PINNED_THREADS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggleThread = useCallback(
    (projectId: string, threadId: string) => {
      const key = pinnedThreadKey(projectId, threadId);
      const pinned = !pinnedThreadKeys.has(key);
      const persisted = writeStoredThreadPinned(projectId, threadId, pinned);
      const next = new Set(pinnedThreadKeys);
      if (pinned) next.add(key);
      else next.delete(key);
      setPinnedThreadKeys(next);
      if (persisted) window.dispatchEvent(new Event(PINNED_THREADS_CHANGED_EVENT));
    },
    [pinnedThreadKeys],
  );

  const value = useMemo(() => ({ pinnedThreadKeys, toggleThread }), [pinnedThreadKeys, toggleThread]);
  return <ThreadPinningContext.Provider value={value}>{children}</ThreadPinningContext.Provider>;
}

export function useThreadPinning(): ThreadPinningContextValue {
  return useContext(ThreadPinningContext);
}
