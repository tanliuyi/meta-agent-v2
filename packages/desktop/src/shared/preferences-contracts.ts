/**
 * UI 偏好的配置文件契约（userData/preferences.json）。
 *
 * 持久化语义：renderer 各偏好模块以原有存储键读写字符串值（格式由各模块解析），
 * 配置服务只负责保存 values 的字符串映射，不做字段级校验。
 * 保存采用"最后写入胜出"的合并语义，服务端锁串行化写入。
 */

export const PREFERENCES_FILE_VERSION = 1;

export interface PreferencesSnapshot {
  path: string;
  exists: boolean;
  values: Record<string, string>;
}

export interface SavePreferencesInput {
  values: Record<string, string>;
}

export type SavePreferencesResult = { status: "saved" } | { status: "failed"; reason: string };
