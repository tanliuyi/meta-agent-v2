export const PINNED_THREADS_STORAGE_KEY = "pi-desktop:pinned-threads";
const PINNED_THREADS_STORAGE_VERSION = 1;

type PinnedThreadEntry = readonly [projectId: string, threadId: string];
type ReadValue = () => string | null;
type WriteValue = (value: string) => void;

interface StoredPinnedThreads {
  version: typeof PINNED_THREADS_STORAGE_VERSION;
  threads: PinnedThreadEntry[];
}

const defaultReadValue: ReadValue = () => window.localStorage.getItem(PINNED_THREADS_STORAGE_KEY);
const defaultWriteValue: WriteValue = (value) => window.localStorage.setItem(PINNED_THREADS_STORAGE_KEY, value);

/** 使用稳定的结构化键区分不同项目中的同名 session。 */
export function pinnedThreadKey(projectId: string, threadId: string): string {
  return JSON.stringify([projectId, threadId]);
}

export function parseStoredPinnedThreads(value: string | null): ReadonlySet<string> {
  if (value === null) return new Set();

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== PINNED_THREADS_STORAGE_VERSION || !Array.isArray(parsed.threads)) {
      return new Set();
    }

    const pinned = new Set<string>();
    for (const entry of parsed.threads) {
      if (!isPinnedThreadEntry(entry)) continue;
      pinned.add(pinnedThreadKey(entry[0], entry[1]));
    }
    return pinned;
  } catch {
    return new Set();
  }
}

export function readStoredPinnedThreads(readValue: ReadValue = defaultReadValue): ReadonlySet<string> {
  try {
    return parseStoredPinnedThreads(readValue());
  } catch {
    return new Set();
  }
}

export function writeStoredThreadPinned(
  projectId: string,
  threadId: string,
  pinned: boolean,
  readValue: ReadValue = defaultReadValue,
  writeValue: WriteValue = defaultWriteValue,
): boolean {
  try {
    const pinnedKeys = new Set(parseStoredPinnedThreads(readValue()));
    const key = pinnedThreadKey(projectId, threadId);
    if (pinned) pinnedKeys.add(key);
    else pinnedKeys.delete(key);

    const threads = [...pinnedKeys].flatMap((key) => {
      const entry = parsePinnedThreadKey(key);
      return entry ? [entry] : [];
    });
    writeValue(JSON.stringify({ version: PINNED_THREADS_STORAGE_VERSION, threads } satisfies StoredPinnedThreads));
    return true;
  } catch {
    // 当前窗口仍可置顶或取消置顶，持久化失败不应阻断交互。
    return false;
  }
}

export function pinnedThreadProjectIds(pinnedThreadKeys: ReadonlySet<string>): ReadonlySet<string> {
  const projectIds = new Set<string>();
  for (const key of pinnedThreadKeys) {
    const entry = parsePinnedThreadKey(key);
    if (entry) projectIds.add(entry[0]);
  }
  return projectIds;
}

export function parsePinnedThreadKey(value: string): PinnedThreadEntry | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isPinnedThreadEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPinnedThreadEntry(value: unknown): value is PinnedThreadEntry {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
