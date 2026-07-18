import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useState } from "react";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

const THEME_STORAGE_KEY = "meta-agent:theme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function parseThemePreference(value: string | null): ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value) ? (value as ThemePreference) : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export function initializeTheme(): void {
  const preference = readStoredPreference();
  applyTheme(preference, resolveTheme(preference, readSystemPrefersDark()));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark);
  const resolvedTheme = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    applyTheme(preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  const setPreference = (nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // Theme still applies for the current window when storage is unavailable.
    }
  };

  return <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function readSystemPrefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function applyTheme(preference: ThemePreference, resolvedTheme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolvedTheme;
}
