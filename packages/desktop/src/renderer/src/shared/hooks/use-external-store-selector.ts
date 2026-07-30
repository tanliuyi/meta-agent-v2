import { useCallback, useSyncExternalStore } from "react";

interface ExternalStore<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: () => void): () => void;
}

/** 仅在 selector 结果发生 Object.is 变化时更新消费组件。 */
export function useExternalStoreSelector<TSnapshot, TSelected>(
  store: ExternalStore<TSnapshot>,
  selector: (snapshot: TSnapshot) => TSelected,
): TSelected {
  const getSelectedSnapshot = useCallback(() => selector(store.getSnapshot()), [selector, store]);
  return useSyncExternalStore(store.subscribe, getSelectedSnapshot, getSelectedSnapshot);
}
