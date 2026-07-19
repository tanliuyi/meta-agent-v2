export const SIDEBAR_WIDTH_STORAGE_KEY = "meta-agent:sidebar-width";
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_COMPACT_MAX_WIDTH = 236;
export const SIDEBAR_COMPACT_BREAKPOINT = 1100;

export function normalizeSidebarWidth(value: number): number {
  return Math.round(Math.min(Math.max(value, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
}

export function parseSidebarWidth(value: string | null): number {
  if (value === null || value.trim() === "") return SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? normalizeSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
}

export function readStoredSidebarWidth(
  readValue: () => string | null = () => window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY),
): number {
  try {
    return parseSidebarWidth(readValue());
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writeStoredSidebarWidth(
  width: number,
  writeValue: (value: string) => void = (value) => window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, value),
): void {
  try {
    writeValue(String(normalizeSidebarWidth(width)));
  } catch {
    // 当前窗口仍可调整布局，持久化失败不应阻断交互。
  }
}

export function getSidebarMaxWidth(viewportWidth: number = window.innerWidth): number {
  if (viewportWidth <= SIDEBAR_COMPACT_BREAKPOINT) return SIDEBAR_COMPACT_MAX_WIDTH;
  return Math.min(viewportWidth * 0.4, SIDEBAR_MAX_WIDTH);
}
