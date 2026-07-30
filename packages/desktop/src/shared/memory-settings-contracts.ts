export type MemoryPromptMode = "policy-only" | "legacy-inject";
export type MemoryPolicyStyle = "full" | "compact" | "custom" | "none";
export type MemoryOverflowStrategy = "auto-consolidate" | "reject" | "fifo-evict";
export type MemorySessionSearchVariant = "legacy" | "anchors";
export type MemoryEntryTarget = "memory" | "user" | "failure" | "project";
export type MemoryMaintenanceAction = "index-sessions" | "sync-markdown";

export interface MemorySettings {
  memoryMode: MemoryPromptMode;
  memoryPolicyStyle: MemoryPolicyStyle;
  memoryPolicyCustomText: string;
  memoryCharLimit: number;
  userCharLimit: number;
  projectCharLimit: number;
  reviewEnabled: boolean;
  nudgeInterval: number;
  nudgeToolCalls: number;
  correctionDetection: boolean;
  flushOnCompact: boolean;
  flushOnShutdown: boolean;
  flushMinTurns: number;
  memoryOverflowStrategy: MemoryOverflowStrategy;
  sessionSearchVariant: MemorySessionSearchVariant;
}

export interface MemoryEntrySummary {
  id: string;
  content: string;
}

export interface MemoryEntryCollection {
  target: MemoryEntryTarget;
  projectId?: string;
  projectName?: string;
  entries: MemoryEntrySummary[];
  charCount: number;
  charLimit: number;
}

export interface MemoryProjectSummary {
  id: string;
  name: string;
  memoryKey: string;
  available: boolean;
  issue?: string;
  entryCount: number;
  charCount: number;
}

export interface MemorySkillSummary {
  skillId: string;
  scope: "global" | "project";
  name: string;
  displayName?: string;
  description: string;
  projectName?: string;
}

export interface MemorySettingsSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  settings: MemorySettings;
  collections: MemoryEntryCollection[];
  projects: MemoryProjectSummary[];
  skills: MemorySkillSummary[];
  contextPreview: string;
}

export interface SaveMemorySettingsInput {
  expectedRevision: string;
  settings: MemorySettings;
}

export type SaveMemorySettingsResult =
  | { status: "saved"; snapshot?: MemorySettingsSnapshot; warning?: string }
  | { status: "conflict"; current: MemorySettingsSnapshot };

export interface MutateMemoryEntryInput {
  expectedRevision: string;
  action: "add" | "replace" | "remove";
  target: MemoryEntryTarget;
  projectId?: string;
  content?: string;
  entryId?: string;
}

export interface MemoryMutationResult {
  success: boolean;
  message?: string;
  warning?: string;
  error?: string;
  snapshot?: MemorySettingsSnapshot;
}

export interface RunMemoryMaintenanceInput {
  action: MemoryMaintenanceAction;
}

export interface MemoryMaintenanceResult {
  success: boolean;
  message: string;
  snapshot?: MemorySettingsSnapshot;
}

const PROMPT_MODES: readonly MemoryPromptMode[] = ["policy-only", "legacy-inject"];
const POLICY_STYLES: readonly MemoryPolicyStyle[] = ["full", "compact", "custom", "none"];
const OVERFLOW_STRATEGIES: readonly MemoryOverflowStrategy[] = ["auto-consolidate", "reject", "fifo-evict"];
const SEARCH_VARIANTS: readonly MemorySessionSearchVariant[] = ["legacy", "anchors"];

export function validateMemorySettings(settings: MemorySettings): string[] {
  const errors: string[] = [];
  if (!PROMPT_MODES.includes(settings.memoryMode)) errors.push("记忆提示模式无效");
  if (!POLICY_STYLES.includes(settings.memoryPolicyStyle)) errors.push("记忆策略样式无效");
  if (typeof settings.memoryPolicyCustomText !== "string") errors.push("自定义策略文本无效");
  if (
    settings.memoryMode === "policy-only" &&
    settings.memoryPolicyStyle === "custom" &&
    settings.memoryPolicyCustomText.trim().length === 0
  ) {
    errors.push("自定义策略文本不能为空");
  }
  validateInteger(errors, settings.memoryCharLimit, "全局记忆容量", 1);
  validateInteger(errors, settings.userCharLimit, "用户资料容量", 1);
  validateInteger(errors, settings.projectCharLimit, "项目记忆容量", 1);
  validateInteger(errors, settings.nudgeInterval, "复盘对话轮数", 1);
  validateInteger(errors, settings.nudgeToolCalls, "复盘工具调用数", 1);
  validateInteger(errors, settings.flushMinTurns, "写回最少轮数", 0);
  if (typeof settings.reviewEnabled !== "boolean") errors.push("后台复盘开关无效");
  if (typeof settings.correctionDetection !== "boolean") errors.push("纠错学习开关无效");
  if (typeof settings.flushOnCompact !== "boolean") errors.push("压缩前写回开关无效");
  if (typeof settings.flushOnShutdown !== "boolean") errors.push("退出时写回开关无效");
  if (!OVERFLOW_STRATEGIES.includes(settings.memoryOverflowStrategy)) errors.push("容量溢出策略无效");
  if (!SEARCH_VARIANTS.includes(settings.sessionSearchVariant)) errors.push("会话检索模式无效");
  return errors;
}

function validateInteger(errors: string[], value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 10_000_000) {
    errors.push(`${label}必须是 ${minimum} 到 10000000 之间的整数`);
  }
}
