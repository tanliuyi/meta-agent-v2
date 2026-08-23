import type { DraftSessionConfig, ThinkingLevel } from "../../../shared/contracts.ts";
import { isThinkingLevel } from "../../../shared/thinking-levels.ts";
import { selectDraftModel, selectDraftThinkingLevel } from "./draft-creation.ts";
import { preferencesStorage } from "./preferences-store.ts";

export const DRAFT_SELECTION_STORAGE_KEY = "pi-desktop:draft-selection";
const DRAFT_SELECTION_STORAGE_VERSION = 1;

/** 新会话最近使用的项目。 */
export const DRAFT_PROJECT_STORAGE_KEY = "pi-desktop:draft-project";

/** 新会话草稿最近一次选择的模型与思考等级（按项目记忆）。 */
export interface StoredDraftSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

interface StoredDraftSelectionPreferences {
  version: typeof DRAFT_SELECTION_STORAGE_VERSION;
  projects: Array<[projectId: string, selection: StoredDraftSelection]>;
}

type ReadValue = () => string | null;
type WriteValue = (value: string) => void;

const defaultReadValue: ReadValue = () => preferencesStorage.getItem(DRAFT_SELECTION_STORAGE_KEY);
const defaultWriteValue: WriteValue = (value) => preferencesStorage.setItem(DRAFT_SELECTION_STORAGE_KEY, value);

const defaultProjectReadValue: ReadValue = () => preferencesStorage.getItem(DRAFT_PROJECT_STORAGE_KEY);
const defaultProjectWriteValue: WriteValue = (value) => preferencesStorage.setItem(DRAFT_PROJECT_STORAGE_KEY, value);

export function readStoredDraftSelection(
  projectId: string,
  readValue: ReadValue = defaultReadValue,
): StoredDraftSelection | null {
  try {
    return parseStoredDraftSelections(readValue()).get(projectId) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredDraftSelection(
  projectId: string,
  selection: StoredDraftSelection,
  readValue: ReadValue = defaultReadValue,
  writeValue: WriteValue = defaultWriteValue,
): void {
  try {
    const projects = new Map(parseStoredDraftSelections(readValue()));
    projects.set(projectId, selection);
    const preferences: StoredDraftSelectionPreferences = {
      version: DRAFT_SELECTION_STORAGE_VERSION,
      projects: [...projects],
    };
    writeValue(JSON.stringify(preferences));
  } catch {
    // 当前窗口仍可选择模型或思考等级，持久化失败不应阻断交互。
  }
}

export function parseStoredDraftSelections(value: string | null): ReadonlyMap<string, StoredDraftSelection> {
  if (value === null) return new Map();

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== DRAFT_SELECTION_STORAGE_VERSION || !Array.isArray(parsed.projects)) {
      return new Map();
    }

    const projects = new Map<string, StoredDraftSelection>();
    for (const entry of parsed.projects) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [projectId, selection] = entry;
      if (typeof projectId !== "string" || !isStoredDraftSelection(selection)) continue;
      projects.set(projectId, selection);
    }
    return projects;
  } catch {
    return new Map();
  }
}

export function readStoredDraftProject(readValue: ReadValue = defaultProjectReadValue): string | null {
  try {
    const value = readValue();
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredDraftProject(projectId: string, writeValue: WriteValue = defaultProjectWriteValue): void {
  try {
    writeValue(projectId);
  } catch {
    // 当前窗口仍可选择项目，持久化失败不应阻断交互。
  }
}

/** 草稿配置加载后套用该项目最近一次的选择；模型或思考等级不可用时保持默认。 */
export function applyStoredDraftSelection(
  config: DraftSessionConfig,
  projectId: string,
  readValue: ReadValue = defaultReadValue,
): DraftSessionConfig {
  const stored = readStoredDraftSelection(projectId, readValue);
  if (!stored) return config;
  const withModel = selectDraftModel(config, stored.provider, stored.modelId) ?? config;
  return selectDraftThinkingLevel(withModel, stored.thinkingLevel) ?? withModel;
}

/** 将草稿当前选择持久化为该项目的新会话偏好。 */
export function persistDraftSelection(
  projectId: string | null,
  config: DraftSessionConfig | null,
  readValue: ReadValue = defaultReadValue,
  writeValue: WriteValue = defaultWriteValue,
): void {
  if (!config?.model || !projectId) return;
  writeStoredDraftSelection(
    projectId,
    {
      provider: config.model.provider,
      modelId: config.model.id,
      thinkingLevel: config.thinkingLevel,
    },
    readValue,
    writeValue,
  );
}

function isStoredDraftSelection(value: unknown): value is StoredDraftSelection {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.modelId === "string" &&
    isThinkingLevel(value.thinkingLevel)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
