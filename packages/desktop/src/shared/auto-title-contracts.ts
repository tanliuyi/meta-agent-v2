/**
 * Contracts for the built-in auto session title extension (pi-auto-title).
 *
 * The Desktop settings UI reads and writes `agentDir/auto-title-config.json`
 * through AutoTitleSettingsService; the extension loads the same file with
 * loadAutoTitleConfig() so no host-side configuration plumbing is required.
 */

export interface AutoTitleSettings {
  /** Master switch. When false the extension never generates titles. */
  enabled: boolean;
  /** Provider id for the title model. Empty means the current session model. */
  providerId: string;
  /** Model id for the title model. Empty means the current session model. */
  modelId: string;
  /** System prompt sent to the LLM when generating a title. */
  systemPrompt: string;
  /** Maximum title length in characters. */
  maxLength: number;
}

export interface AutoTitleSettingsSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  settings: AutoTitleSettings;
}

export interface AutoTitleModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export function autoTitleModelOptionId(option: Pick<AutoTitleModelOption, "provider" | "modelId">): string {
  return `${option.provider}/${option.modelId}`;
}

export interface SaveAutoTitleSettingsInput {
  expectedRevision: string;
  settings: AutoTitleSettings;
}

export type SaveAutoTitleSettingsResult =
  | { status: "saved"; snapshot: AutoTitleSettingsSnapshot }
  | { status: "conflict"; current: AutoTitleSettingsSnapshot };

export const AUTO_TITLE_MAX_LENGTH_DEFAULT = 60;
export const AUTO_TITLE_MAX_LENGTH_MAX = 200;

export const DEFAULT_AUTO_TITLE_SYSTEM_PROMPT =
  "你是会话标题生成器。根据提供的对话内容，生成一个简短、准确、能概括用户主要目标的会话标题。" +
  "标题使用用户消息的主要语言；优先描述要解决的问题、要实现的功能或要完成的任务，而不是泛泛描述为‘代码修改’。" +
  "标题应是单行短语，不要以句号结尾，不要虚构对话中没有出现的内容。";

export function defaultAutoTitleSettings(): AutoTitleSettings {
  return {
    enabled: true,
    providerId: "",
    modelId: "",
    systemPrompt: DEFAULT_AUTO_TITLE_SYSTEM_PROMPT,
    maxLength: AUTO_TITLE_MAX_LENGTH_DEFAULT,
  };
}

export function normalizeAutoTitleSettings(settings: AutoTitleSettings): AutoTitleSettings {
  return {
    enabled: settings.enabled === true,
    providerId: typeof settings.providerId === "string" ? settings.providerId.trim() : "",
    modelId: typeof settings.modelId === "string" ? settings.modelId.trim() : "",
    systemPrompt:
      typeof settings.systemPrompt === "string" && settings.systemPrompt.trim().length > 0
        ? settings.systemPrompt.trim()
        : DEFAULT_AUTO_TITLE_SYSTEM_PROMPT,
    maxLength: clampTitleMaxLength(settings.maxLength),
  };
}

export function validateAutoTitleSettings(settings: AutoTitleSettings): string[] {
  const errors: string[] = [];
  if (typeof settings.enabled !== "boolean") errors.push("启用开关无效");
  if (typeof settings.providerId !== "string") errors.push("服务商无效");
  if (typeof settings.modelId !== "string") errors.push("模型无效");
  if (typeof settings.systemPrompt !== "string") errors.push("提示词无效");
  if (
    !Number.isSafeInteger(settings.maxLength) ||
    settings.maxLength < 1 ||
    settings.maxLength > AUTO_TITLE_MAX_LENGTH_MAX
  ) {
    errors.push(`标题最大长度必须是 1 到 ${AUTO_TITLE_MAX_LENGTH_MAX} 之间的整数`);
  }
  return errors;
}

export function clampTitleMaxLength(value: number): number {
  if (!Number.isFinite(value)) return AUTO_TITLE_MAX_LENGTH_DEFAULT;
  return Math.min(AUTO_TITLE_MAX_LENGTH_MAX, Math.max(1, Math.floor(value)));
}
