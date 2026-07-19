import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
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
  setPreference(preference: ThemePreference): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** 为 Renderer 提供持久化主题偏好和已解析主题，不持有任何颜色值。 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark);
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    return observeSystemTheme((query) => window.matchMedia(query), setSystemPrefersDark);
  }, []);

  useLayoutEffect(() => {
    applyThemePreference(document.documentElement, preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  const setPreference = useCallback((nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    writeStoredThemePreference(nextPreference);
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
