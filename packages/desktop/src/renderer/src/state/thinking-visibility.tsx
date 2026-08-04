import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampMessageWidth,
  type DesktopSettings,
  MESSAGE_WIDTH_DEFAULT,
  type SettingsConfigSnapshot,
} from "../../../shared/settings-config-contracts.ts";
import { applyMessageWidth } from "./message-width-preference.ts";

interface ThinkingVisibilityContextValue {
  showThinking: boolean;
  autoExpandRunning: boolean;
  showAvatars: boolean;
  messageWidth: number | null;
  userName: string;
  userAvatarPath: string | null;
  canUpdateMessageSettings: boolean;
  setShowThinking(showThinking: boolean): Promise<void>;
  setAutoExpandRunning(autoExpandRunning: boolean): Promise<void>;
  setShowAvatars(showAvatars: boolean): Promise<void>;
  setMessageWidth(messageWidth: number | null): void;
  setUserProfile(userName: string, userAvatarPath: string | null): Promise<boolean>;
}

const ThinkingVisibilityContext = createContext<ThinkingVisibilityContextValue | undefined>(undefined);

const DEFAULT_SETTINGS: DesktopSettings = {
  showThinking: true,
  autoExpandRunning: true,
  showAvatars: true,
  messageWidth: MESSAGE_WIDTH_DEFAULT,
  userName: "用户",
  userAvatarPath: null,
  terminalShellPath: null,
};

/** 消息宽度停止输入后延迟持久化（ms）。 */
const MESSAGE_WIDTH_SAVE_DELAY = 350;
/** 上一次保存尚未结束时重试持久化（ms）。 */
const MESSAGE_WIDTH_SAVE_RETRY_DELAY = 120;

/** 为 renderer 提供由 Desktop settings.json 保存的消息展示偏好。 */
export function ThinkingVisibilityProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [canUpdateMessageSettings, setCanUpdateMessageSettings] = useState(false);
  const snapshotRef = useRef<SettingsConfigSnapshot | undefined>(undefined);
  const saving = useRef(false);
  const latestSettingsRef = useRef(settings);
  const pendingMessageWidthRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    void window.desktop.settings
      .getConfig()
      .then((snapshot) => {
        if (disposed) return;
        snapshotRef.current = snapshot;
        latestSettingsRef.current = snapshot.settings;
        pendingMessageWidthRef.current = false;
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

  // 消息宽度即时生效：写入根节点 CSS 变量，默认值移除变量回到 token 回退。
  useLayoutEffect(() => {
    applyMessageWidth(document.documentElement, settings.messageWidth);
  }, [settings.messageWidth]);

  const updateSettings = useCallback(async (nextSettings: DesktopSettings): Promise<boolean> => {
    const current = snapshotRef.current;
    if (!current || saving.current) return false;
    if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    pendingMessageWidthRef.current = false;
    saving.current = true;
    setCanUpdateMessageSettings(false);
    latestSettingsRef.current = nextSettings;
    setSettings(nextSettings);
    try {
      const result = await window.desktop.settings.saveConfig({
        expectedRevision: current.revision,
        settings: nextSettings,
      });
      const snapshot = result.status === "saved" ? result.snapshot : result.current;
      snapshotRef.current = snapshot;
      latestSettingsRef.current = snapshot.settings;
      setSettings(snapshot.settings);
      return result.status === "saved";
    } catch {
      latestSettingsRef.current = current.settings;
      setSettings(current.settings);
      return false;
    } finally {
      saving.current = false;
      setCanUpdateMessageSettings(true);
    }
  }, []);

  const persistMessageWidth = useCallback((retry = true) => {
    const current = snapshotRef.current;
    if (!current) return;
    if (saving.current) {
      if (retry) {
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = undefined;
          persistMessageWidth();
        }, MESSAGE_WIDTH_SAVE_RETRY_DELAY);
      }
      return;
    }
    saving.current = true;
    setCanUpdateMessageSettings(false);
    const nextSettings = latestSettingsRef.current;
    void window.desktop.settings
      .saveConfig({ expectedRevision: current.revision, settings: nextSettings })
      .then((result) => {
        const snapshot = result.status === "saved" ? result.snapshot : result.current;
        snapshotRef.current = snapshot;
        if (latestSettingsRef.current.messageWidth === nextSettings.messageWidth) {
          pendingMessageWidthRef.current = false;
          latestSettingsRef.current = snapshot.settings;
        }
        // 保存期间若又产生新改动，保留本地新值；否则收敛到已保存快照。
        setSettings((previous) => (previous.messageWidth === nextSettings.messageWidth ? snapshot.settings : previous));
      })
      .catch(() => {
        if (latestSettingsRef.current.messageWidth === nextSettings.messageWidth) {
          pendingMessageWidthRef.current = false;
          latestSettingsRef.current = current.settings;
        }
        setSettings((previous) => (previous.messageWidth === nextSettings.messageWidth ? current.settings : previous));
      })
      .finally(() => {
        saving.current = false;
        setCanUpdateMessageSettings(true);
      });
  }, []);

  const setMessageWidth = useCallback(
    (messageWidth: number | null) => {
      const clamped = messageWidth === null ? null : clampMessageWidth(messageWidth);
      const nextSettings = { ...latestSettingsRef.current, messageWidth: clamped };
      latestSettingsRef.current = nextSettings;
      pendingMessageWidthRef.current = true;
      setSettings(nextSettings);
      if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = undefined;
        persistMessageWidth();
      }, MESSAGE_WIDTH_SAVE_DELAY);
    },
    [persistMessageWidth],
  );

  useEffect(
    () => () => {
      if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      if (pendingMessageWidthRef.current) persistMessageWidth(false);
    },
    [persistMessageWidth],
  );

  const setShowThinking = useCallback(
    async (showThinking: boolean) => {
      await updateSettings({ ...settings, showThinking });
    },
    [settings, updateSettings],
  );
  const setAutoExpandRunning = useCallback(
    async (autoExpandRunning: boolean) => {
      await updateSettings({ ...settings, autoExpandRunning });
    },
    [settings, updateSettings],
  );
  const setShowAvatars = useCallback(
    async (showAvatars: boolean) => {
      await updateSettings({ ...settings, showAvatars });
    },
    [settings, updateSettings],
  );
  const setUserProfile = useCallback(
    (userName: string, userAvatarPath: string | null) => updateSettings({ ...settings, userName, userAvatarPath }),
    [settings, updateSettings],
  );

  const value = useMemo(
    () => ({
      showThinking: settings.showThinking,
      autoExpandRunning: settings.autoExpandRunning,
      showAvatars: settings.showAvatars,
      messageWidth: settings.messageWidth,
      userName: settings.userName,
      userAvatarPath: settings.userAvatarPath,
      canUpdateMessageSettings,
      setShowThinking,
      setAutoExpandRunning,
      setShowAvatars,
      setMessageWidth,
      setUserProfile,
    }),
    [
      settings,
      canUpdateMessageSettings,
      setShowThinking,
      setAutoExpandRunning,
      setShowAvatars,
      setMessageWidth,
      setUserProfile,
    ],
  );

  return <ThinkingVisibilityContext.Provider value={value}>{children}</ThinkingVisibilityContext.Provider>;
}

export function useThinkingVisibility(): ThinkingVisibilityContextValue {
  const value = useContext(ThinkingVisibilityContext);
  if (!value) throw new Error("useThinkingVisibility must be used inside ThinkingVisibilityProvider");
  return value;
}
