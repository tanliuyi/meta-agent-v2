import { beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({ updates: 0, unsubscribe: null as (() => void) | null }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
    let current = getSnapshot();
    reactState.unsubscribe = subscribe(() => {
      const next = getSnapshot();
      if (Object.is(current, next)) return;
      current = next;
      reactState.updates += 1;
    });
    return current;
  },
}));

import { useExternalStoreSelector } from "../src/renderer/src/shared/hooks/use-external-store-selector.ts";

describe("useExternalStoreSelector", () => {
  beforeEach(() => {
    reactState.updates = 0;
    reactState.unsubscribe = null;
  });

  it("忽略 selector 结果未变化的 store 通知", () => {
    const selected = { value: "stable" };
    let snapshot = { revision: 1, selected };
    const listeners = new Set<() => void>();
    const store = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    expect(useExternalStoreSelector(store, (value) => value.selected)).toBe(selected);
    snapshot = { revision: 2, selected };
    for (const listener of listeners) listener();
    expect(reactState.updates).toBe(0);

    snapshot = { revision: 3, selected: { value: "changed" } };
    for (const listener of listeners) listener();
    expect(reactState.updates).toBe(1);
    reactState.unsubscribe?.();
  });
});
