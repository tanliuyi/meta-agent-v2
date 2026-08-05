import type {
  PreferencesSnapshot,
  SavePreferencesInput,
  SavePreferencesResult,
} from "../../../shared/preferences-contracts.ts";

/**
 * UI 偏好的 renderer 侧存储（替代 localStorage）。
 *
 * - 读取：惰性同步快照（preload sendSync 从 preferences.json 读取），首帧初始化
 *   （主题/字体）可在 React root 创建前同步拿到持久化值。
 * - 写入：先更新内存缓存（当前窗口立即生效），再以合并节流异步落盘到
 *   preferences.json；持久化失败不阻断交互，后续写入会携带最新缓存重试。
 */

export const PREFERENCES_SAVE_DELAY_MS = 300;

export interface PreferencesPersistence {
  getInitial(): PreferencesSnapshot;
  save(input: SavePreferencesInput): Promise<SavePreferencesResult>;
}

export interface PreferencesKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** 仅供测试：清空内存缓存与待落盘计时，使下一次读取重新加载初始快照。 */
  reset(): void;
}

interface CreatePreferencesStoreOptions {
  persistence: PreferencesPersistence;
  saveDelayMs?: number;
  timer?: typeof setTimeout;
}

export function createPreferencesStore(options: CreatePreferencesStoreOptions): PreferencesKeyValueStore {
  const { persistence, saveDelayMs = PREFERENCES_SAVE_DELAY_MS, timer = setTimeout } = options;
  let values: Record<string, string> | null = null;
  let saveTimer: ReturnType<typeof timer> | null = null;

  function load(): Record<string, string> {
    if (values === null) {
      try {
        values = { ...persistence.getInitial().values };
      } catch {
        values = {};
      }
    }
    return values;
  }

  function scheduleSave(): void {
    if (saveTimer !== null) return;
    saveTimer = timer(() => {
      saveTimer = null;
      if (values === null) return;
      const input: SavePreferencesInput = { values: { ...values } };
      void persistence.save(input).catch(() => {
        // 持久化失败不阻断交互；当前窗口仍持有最新缓存，下次写入会重试。
      });
    }, saveDelayMs);
  }

  return {
    getItem(key) {
      return load()[key] ?? null;
    },
    setItem(key, value) {
      load()[key] = value;
      scheduleSave();
    },
    reset() {
      values = null;
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
    },
  };
}

const defaultPersistence: PreferencesPersistence = {
  getInitial: () => window.desktop.preferences.getInitial(),
  save: (input) => window.desktop.preferences.save(input),
};

/** 应用级默认实例；读取惰性触发，测试直接构造 createPreferencesStore 注入 fake。 */
export const preferencesStorage: PreferencesKeyValueStore = createPreferencesStore({
  persistence: defaultPersistence,
});
