import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { sanitizeUiFontFamily } from "./font-preference.ts";
import {
  applyTerminalPreferences,
  clampTerminalFontSize,
  readStoredTerminalFontFamily,
  readStoredTerminalFontSize,
  type TerminalPreferences,
  writeStoredTerminalFontFamily,
  writeStoredTerminalFontSize,
} from "./terminal-preference.ts";

interface TerminalContextValue {
  fontFamily: string;
  fontSize: number;
  setFontFamily(fontFamily: string): void;
  setFontSize(fontSize: number): void;
}

const TerminalContext = createContext<TerminalContextValue | undefined>(undefined);

/** 为 Renderer 提供持久化终端字体偏好，默认字体栈与档位字号仍由 CSS token 拥有。 */
export function TerminalProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<TerminalPreferences>(() => ({
    fontFamily: readStoredTerminalFontFamily(),
    fontSize: readStoredTerminalFontSize(),
  }));

  useLayoutEffect(() => {
    applyTerminalPreferences(document.documentElement, preferences);
  }, [preferences]);

  const setFontFamily = useCallback((fontFamily: string) => {
    const sanitized = sanitizeUiFontFamily(fontFamily);
    setPreferences((previous) => ({ ...previous, fontFamily: sanitized }));
    writeStoredTerminalFontFamily(sanitized);
  }, []);

  const setFontSize = useCallback((fontSize: number) => {
    const clamped = clampTerminalFontSize(fontSize);
    setPreferences((previous) => ({ ...previous, fontSize: clamped }));
    writeStoredTerminalFontSize(clamped);
  }, []);

  const value = useMemo(
    () => ({ fontFamily: preferences.fontFamily, fontSize: preferences.fontSize, setFontFamily, setFontSize }),
    [preferences, setFontFamily, setFontSize],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("useTerminal must be used inside TerminalProvider");
  return value;
}
