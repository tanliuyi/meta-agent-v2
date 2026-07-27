import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopSettings, SettingsConfigSnapshot } from "../../../shared/settings-config-contracts.ts";

interface ThinkingVisibilityContextValue {
  showThinking: boolean;
  autoExpandRunning: boolean;
  canUpdateMessageSettings: boolean;
  setShowThinking(showThinking: boolean): Promise<void>;
  setAutoExpandRunning(autoExpandRunning: boolean): Promise<void>;
}

const ThinkingVisibilityContext = createContext<ThinkingVisibilityContextValue | undefined>(undefined);

/** 为 renderer 提供由 Desktop settings.json 保存的消息展示偏好。 */
export function ThinkingVisibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DesktopSettings>({ showThinking: true, autoExpandRunning: true });
  const [canUpdateMessageSettings, setCanUpdateMessageSettings] = useState(false);
  const snapshotRef = useRef<SettingsConfigSnapshot | undefined>(undefined);
  const saving = useRef(false);

  useEffect(() => {
    let disposed = false;
    void window.desktop.settings
      .getConfig()
      .then((snapshot) => {
        if (disposed) return;
        snapshotRef.current = snapshot;
        setSettings(snapshot.settings);
        setCanUpdateMessageSettings(true);
      })
      .catch(() => {
        if (!disposed) setCanUpdateMessageSettings(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const updateSettings = useCallback(async (nextSettings: DesktopSettings) => {
    const current = snapshotRef.current;
    if (!current || saving.current) return;
    saving.current = true;
    setCanUpdateMessageSettings(false);
    setSettings(nextSettings);
    try {
      const result = await window.desktop.settings.saveConfig({
        expectedRevision: current.revision,
        settings: nextSettings,
      });
      const snapshot = result.status === "saved" ? result.snapshot : result.current;
      snapshotRef.current = snapshot;
      setSettings(snapshot.settings);
    } catch {
      setSettings(current.settings);
    } finally {
      saving.current = false;
      setCanUpdateMessageSettings(true);
    }
  }, []);

  const setShowThinking = useCallback(
    async (showThinking: boolean) => updateSettings({ ...settings, showThinking }),
    [settings, updateSettings],
  );
  const setAutoExpandRunning = useCallback(
    async (autoExpandRunning: boolean) => updateSettings({ ...settings, autoExpandRunning }),
    [settings, updateSettings],
  );

  const value = useMemo(
    () => ({
      showThinking: settings.showThinking,
      autoExpandRunning: settings.autoExpandRunning,
      canUpdateMessageSettings,
      setShowThinking,
      setAutoExpandRunning,
    }),
    [settings, canUpdateMessageSettings, setShowThinking, setAutoExpandRunning],
  );

  return <ThinkingVisibilityContext.Provider value={value}>{children}</ThinkingVisibilityContext.Provider>;
}

export function useThinkingVisibility(): ThinkingVisibilityContextValue {
  const value = useContext(ThinkingVisibilityContext);
  if (!value) throw new Error("useThinkingVisibility must be used inside ThinkingVisibilityProvider");
  return value;
}
