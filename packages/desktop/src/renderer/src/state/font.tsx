import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import {
  applyUiFontPreferences,
  clampUiFontSize,
  readStoredUiFontFamily,
  readStoredUiFontSize,
  sanitizeUiFontFamily,
  type UiFontPreferences,
  writeStoredUiFontFamily,
  writeStoredUiFontSize,
} from "./font-preference.ts";

interface FontContextValue {
  fontFamily: string;
  fontSize: number;
  setFontFamily(fontFamily: string): void;
  setFontSize(fontSize: number): void;
}

const FontContext = createContext<FontContextValue | undefined>(undefined);

/** 为 Renderer 提供持久化 UI 字体偏好，默认字体栈与档位字号仍由 CSS token 拥有。 */
export function FontProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UiFontPreferences>(() => ({
    fontFamily: readStoredUiFontFamily(),
    fontSize: readStoredUiFontSize(),
  }));

  useLayoutEffect(() => {
    applyUiFontPreferences(document.documentElement, preferences);
  }, [preferences]);

  const setFontFamily = useCallback((fontFamily: string) => {
    const sanitized = sanitizeUiFontFamily(fontFamily);
    setPreferences((previous) => ({ ...previous, fontFamily: sanitized }));
    writeStoredUiFontFamily(sanitized);
  }, []);

  const setFontSize = useCallback((fontSize: number) => {
    const clamped = clampUiFontSize(fontSize);
    setPreferences((previous) => ({ ...previous, fontSize: clamped }));
    writeStoredUiFontSize(clamped);
  }, []);

  const value = useMemo(
    () => ({ fontFamily: preferences.fontFamily, fontSize: preferences.fontSize, setFontFamily, setFontSize }),
    [preferences, setFontFamily, setFontSize],
  );

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}

export function useFont(): FontContextValue {
  const value = useContext(FontContext);
  if (!value) throw new Error("useFont must be used inside FontProvider");
  return value;
}
