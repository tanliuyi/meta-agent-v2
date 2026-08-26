import type { SessionBrowserUiSnapshot } from "../../../runtime/pi-session-store.ts";

export interface BrowserSessionSnapshotEntry {
  url: string;
  active: boolean;
}

export function browserSessionSnapshot(
  entries: readonly BrowserSessionSnapshotEntry[],
  fallbackActiveIndex: number,
): SessionBrowserUiSnapshot {
  const visibleEntries = entries.filter(({ url }) => url.length > 0);
  const activeIndex = visibleEntries.findIndex(({ active }) => active);
  return {
    urls: visibleEntries.map(({ url }) => url),
    activeIndex:
      activeIndex >= 0
        ? activeIndex
        : Math.min(Math.max(Math.trunc(fallbackActiveIndex), 0), Math.max(visibleEntries.length - 1, 0)),
  };
}

export function normalizeBrowserSessionSnapshot(snapshot: SessionBrowserUiSnapshot): SessionBrowserUiSnapshot {
  return browserSessionSnapshot(
    snapshot.urls.map((url, index) => ({ url, active: index === Math.trunc(snapshot.activeIndex) })),
    snapshot.activeIndex,
  );
}
