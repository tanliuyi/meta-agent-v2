import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

interface ReasoningDisclosureStore {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
  delete(key: string): void;
}

const ReasoningDisclosureStateContext = createContext<ReasoningDisclosureStore | null>(null);

export function ReasoningDisclosureStateProvider({
  store,
  children,
}: {
  store: ReasoningDisclosureStore;
  children: ReactNode;
}) {
  return <ReasoningDisclosureStateContext.Provider value={store}>{children}</ReasoningDisclosureStateContext.Provider>;
}

export function useReasoningDisclosureState(stateKey: string | undefined) {
  const store = useContext(ReasoningDisclosureStateContext);
  const [value, setLocalValue] = useState<boolean | null>(() =>
    stateKey === undefined ? null : (store?.get(stateKey) ?? null),
  );
  const setValue = useCallback(
    (nextValue: boolean | null) => {
      setLocalValue(nextValue);
      if (stateKey === undefined || !store) return;
      if (nextValue === null) store.delete(stateKey);
      else store.set(stateKey, nextValue);
    },
    [stateKey, store],
  );

  return [value, setValue] as const;
}
