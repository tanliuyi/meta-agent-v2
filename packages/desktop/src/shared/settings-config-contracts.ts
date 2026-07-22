export interface DesktopSettings {
  showThinking: boolean;
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
