export interface DesktopSettings {
  showThinking: boolean;
  autoExpandRunning: boolean;
  /** 是否在消息旁显示模型提供方头像。 */
  showAvatars: boolean;
  /** 消息列宽度（px），null 表示满屏不限制宽度。 */
  messageWidth: number | null;
  /** 用户消息身份栏显示的名称。 */
  userName: string;
  /** 用户头像的本地绝对路径，null 表示使用默认头像。 */
  userAvatarPath: string | null;
}

export const DEFAULT_USER_NAME = "用户";
export const USER_NAME_MAX_LENGTH = 80;
export const USER_AVATAR_SCHEME = "meta-agent-avatar";

export function userAvatarPathToUrl(path: string): string {
  return `${USER_AVATAR_SCHEME}://local/image?path=${encodeURIComponent(path)}`;
}

export const MESSAGE_WIDTH_MIN = 480;
export const MESSAGE_WIDTH_MAX = 1280;
export const MESSAGE_WIDTH_STEP = 10;
export const MESSAGE_WIDTH_DEFAULT = 810;

/** 收敛到步进刻度并夹取到受支持范围，非有限值回落默认宽度。 */
export function clampMessageWidth(value: number): number {
  if (!Number.isFinite(value)) return MESSAGE_WIDTH_DEFAULT;
  const stepped = Math.round(value / MESSAGE_WIDTH_STEP) * MESSAGE_WIDTH_STEP;
  return Math.min(MESSAGE_WIDTH_MAX, Math.max(MESSAGE_WIDTH_MIN, stepped));
}

export interface SettingsConfigSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  settings: DesktopSettings;
}

export interface SaveSettingsConfigInput {
  expectedRevision: string;
  settings: DesktopSettings;
}

export type SaveSettingsConfigResult =
  | { status: "saved"; snapshot: SettingsConfigSnapshot }
  | { status: "conflict"; current: SettingsConfigSnapshot };
