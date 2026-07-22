import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SettingsConfigSnapshot } from "../../../shared/settings-config-contracts.ts";

interface ThinkingVisibilityContextValue {
  showThinking: boolean;
  canUpdateThinkingVisibility: boolean;
  setShowThinking(showThinking: boolean): Promise<void>;
}

const ThinkingVisibilityContext = createContext<ThinkingVisibilityContextValue | undefined>(undefined);

/** 为 renderer 提供由 Desktop settings.json 保存的 thinking 显示偏好。 */
export function ThinkingVisibilityProvider({ children }: { children: ReactNode }) {
  const [showThinking, setShowThinkingState] = useState(true);
  const [canUpdateThinkingVisibility, setCanUpdateThinkingVisibility] = useState(false);
  const snapshotRef = useRef<SettingsConfigSnapshot | undefined>(undefined);
  const saving = useRef(false);

  useEffect(() => {
    let disposed = false;
    void window.desktop.settings
      .getConfig()
      .then((snapshot) => {
        if (disposed) return;
        snapshotRef.current = snapshot;
        setShowThinkingState(snapshot.settings.showThinking);
        setCanUpdateThinkingVisibility(true);
      })
      .catch(() => {
        if (!disposed) setCanUpdateThinkingVisibility(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const setShowThinking = useCallback(async (nextShowThinking: boolean) => {
    const current = snapshotRef.current;
    if (!current || saving.current) return;
    const previousShowThinking = current.settings.showThinking;
    saving.current = true;
    setCanUpdateThinkingVisibility(false);
    setShowThinkingState(nextShowThinking);
    try {
      const result = await window.desktop.settings.saveConfig({
        expectedRevision: current.revision,
        settings: { ...current.settings, showThinking: nextShowThinking },
      });
      if (result.status === "saved") {
        snapshotRef.current = result.snapshot;
        setShowThinkingState(result.snapshot.settings.showThinking);
      } else {
        snapshotRef.current = result.current;
        setShowThinkingState(result.current.settings.showThinking);
      }
    } catch {
      setShowThinkingState(previousShowThinking);
    } finally {
      saving.current = false;
      setCanUpdateThinkingVisibility(true);
    }
  }, []);

  const value = useMemo(
    () => ({ showThinking, canUpdateThinkingVisibility, setShowThinking }),
    [showThinking, canUpdateThinkingVisibility, setShowThinking],
  );

  return <ThinkingVisibilityContext.Provider value={value}>{children}</ThinkingVisibilityContext.Provider>;
}

export function useThinkingVisibility(): ThinkingVisibilityContextValue {
  const value = useContext(ThinkingVisibilityContext);
  if (!value) throw new Error("useThinkingVisibility must be used inside ThinkingVisibilityProvider");
  return value;
}
