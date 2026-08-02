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
  applyThemeColorPreferences,
  normalizeHexColor,
  readStoredThemeColorPreferences,
  type ThemeColorPreference,
  writeStoredCustomThemeColor,
  writeStoredThemeColorPreference,
} from "./theme-color-preference.ts";
import {
  applyThemePreference,
  observeSystemTheme,
  type ResolvedTheme,
  readStoredThemePreference,
  readSystemPrefersDark,
  resolveTheme,
  type ThemePreference,
  writeStoredThemePreference,
} from "./theme-preference.ts";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  colorPreference: ThemeColorPreference;
  customColor: string;
  setPreference(preference: ThemePreference): void;
  setColorPreference(preference: ThemeColorPreference): void;
  setCustomColor(color: string): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
const CUSTOM_COLOR_SAVE_DELAY = 150;

/** 为 Renderer 提供持久化的明暗模式与主题色偏好。 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);
  const [colorPreferences, setColorPreferences] = useState(readStoredThemeColorPreferences);
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark);
  const customColorSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingCustomColor = useRef<string | undefined>(undefined);
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    return observeSystemTheme((query) => window.matchMedia(query), setSystemPrefersDark);
  }, []);

  useLayoutEffect(() => {
    applyThemePreference(document.documentElement, preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  useLayoutEffect(() => {
    applyThemeColorPreferences(document.documentElement, colorPreferences, resolvedTheme);
  }, [colorPreferences, resolvedTheme]);

  useEffect(
    () => () => {
      if (customColorSaveTimer.current !== undefined) clearTimeout(customColorSaveTimer.current);
      if (pendingCustomColor.current !== undefined) {
        writeStoredThemeColorPreference("custom");
        writeStoredCustomThemeColor(pendingCustomColor.current);
      }
    },
    [],
  );

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    writeStoredThemePreference(nextPreference);
  }, []);

  const setColorPreference = useCallback((nextPreference: ThemeColorPreference) => {
    if (nextPreference !== "custom") {
      if (customColorSaveTimer.current !== undefined) clearTimeout(customColorSaveTimer.current);
      customColorSaveTimer.current = undefined;
      const pendingColor = pendingCustomColor.current;
      pendingCustomColor.current = undefined;
      if (pendingColor !== undefined) writeStoredCustomThemeColor(pendingColor);
    }
    setColorPreferences((previous) => ({ ...previous, preference: nextPreference }));
    writeStoredThemeColorPreference(nextPreference);
  }, []);

  const setCustomColor = useCallback((color: string) => {
    const normalized = normalizeHexColor(color);
    if (!normalized) return;
    setColorPreferences({ preference: "custom", customColor: normalized });
    pendingCustomColor.current = normalized;
    if (customColorSaveTimer.current !== undefined) clearTimeout(customColorSaveTimer.current);
    customColorSaveTimer.current = setTimeout(() => {
      customColorSaveTimer.current = undefined;
      pendingCustomColor.current = undefined;
      writeStoredThemeColorPreference("custom");
      writeStoredCustomThemeColor(normalized);
    }, CUSTOM_COLOR_SAVE_DELAY);
  }, []);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      colorPreference: colorPreferences.preference,
      customColor: colorPreferences.customColor,
      setPreference,
      setColorPreference,
      setCustomColor,
    }),
    [preference, resolvedTheme, colorPreferences, setPreference, setColorPreference, setCustomColor],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
