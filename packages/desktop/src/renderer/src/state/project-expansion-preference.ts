export const PROJECT_EXPANSION_STORAGE_KEY = "pi-desktop:project-expansion";
const PROJECT_EXPANSION_STORAGE_VERSION = 1;

type ProjectExpansionEntry = readonly [projectId: string, expanded: boolean];

interface StoredProjectExpansionPreferences {
  version: typeof PROJECT_EXPANSION_STORAGE_VERSION;
  projects: ProjectExpansionEntry[];
}

export function parseProjectExpansionPreferences(value: string | null): ReadonlyMap<string, boolean> {
  if (value === null) return new Map();

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== PROJECT_EXPANSION_STORAGE_VERSION || !Array.isArray(parsed.projects)) {
      return new Map();
    }

    const projects = new Map<string, boolean>();
    for (const entry of parsed.projects) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [projectId, expanded] = entry;
      if (typeof projectId === "string" && typeof expanded === "boolean") projects.set(projectId, expanded);
    }
    return projects;
  } catch {
    return new Map();
  }
}

export function readStoredProjectExpanded(
  projectId: string,
  fallback: boolean,
  readValue: () => string | null = () => window.localStorage.getItem(PROJECT_EXPANSION_STORAGE_KEY),
): boolean {
  try {
    return parseProjectExpansionPreferences(readValue()).get(projectId) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredProjectExpanded(
  projectId: string,
  expanded: boolean,
  readValue: () => string | null = () => window.localStorage.getItem(PROJECT_EXPANSION_STORAGE_KEY),
  writeValue: (value: string) => void = (value) => window.localStorage.setItem(PROJECT_EXPANSION_STORAGE_KEY, value),
): void {
  try {
    const projects = new Map(parseProjectExpansionPreferences(readValue()));
    projects.set(projectId, expanded);
    const preferences: StoredProjectExpansionPreferences = {
      version: PROJECT_EXPANSION_STORAGE_VERSION,
      projects: [...projects],
    };
    writeValue(JSON.stringify(preferences));
  } catch {
    // 当前窗口仍可展开或收起项目，持久化失败不应阻断交互。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
