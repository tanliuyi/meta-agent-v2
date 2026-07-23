export const DESKTOP_EXTENSION_HOST_PROFILE_VERSION = 1 as const;

export type DesktopExtensionCapability =
  | "events.subscribe"
  | "tools.register"
  | "commands.register"
  | "providers.register"
  | "messages.enqueue"
  | "messages.custom"
  | "session.read"
  | "session.abort"
  | "session.compact"
  | "session.reload"
  | "session.replace"
  | "ui.notify"
  | "ui.dialog"
  | "ui.status"
  | "ui.widget.text"
  | "ui.title"
  | "ui.composer.write"
  | "ui.composer.read"
  | "ui.working"
  | "ui.tui.custom"
  | "ui.tui.theme"
  | "ui.tui.chrome"
  | "ui.tui.editor"
  | "ui.terminal.input";

export type DesktopExtensionSource = "builtin" | "curated" | "development";

export interface DesktopExtensionDiagnostic {
  extensionId: string;
  source: DesktopExtensionSource;
  extensionSetGeneration?: string;
  projectId?: string;
  threadId?: string;
  workerInstanceId?: string;
  phase: "resolve" | "load" | "register" | "start" | "runtime" | "dispose";
  code: string;
  message: string;
}

export interface DesktopExtensionDefinition {
  id: string;
  displayName: string;
  source: "builtin" | "curated";
  entryPath?: string;
  hostProfileVersion: typeof DESKTOP_EXTENSION_HOST_PROFILE_VERSION;
  capabilities: DesktopExtensionCapability[];
}

export interface ResolvedExtensionEntry {
  id: string;
  displayName: string;
  source: DesktopExtensionSource;
  entryPath?: string;
  contentHash?: string;
  hostProfileVersion: typeof DESKTOP_EXTENSION_HOST_PROFILE_VERSION;
  capabilities: DesktopExtensionCapability[];
}

export interface ResolvedExtensionSet {
  generation: string;
  projectId: string;
  entries: ResolvedExtensionEntry[];
  curatedRoot?: string;
  diagnostics: DesktopExtensionDiagnostic[];
  resolvedAt: number;
}

export interface DraftExtensionContext {
  extensionSetGeneration: string;
  diagnostics: DesktopExtensionDiagnostic[];
}

export interface DesktopExtensionHostState {
  statuses: Record<string, string>;
  windowTitle?: string;
  composerCommand?: {
    hostId: string;
    revision: number;
    mode: "replace" | "append";
    text: string;
  };
  widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

export interface DesktopExtensionListEntry {
  id: string;
  displayName: string;
  source: DesktopExtensionSource;
  enabled: boolean;
  configuredEnabled: boolean;
  capabilities: DesktopExtensionCapability[];
  displayPath?: string;
}

export interface DesktopExtensionSettingsSnapshot {
  revision: string;
  developerMode: boolean;
  reloadRequired: boolean;
  appliedGeneration?: string;
  desiredGeneration?: string;
  diagnostics: DesktopExtensionDiagnostic[];
  entries: DesktopExtensionListEntry[];
}

export type DesktopExtensionSettingsMutation =
  | { type: "set-developer-mode"; enabled: boolean }
  | { type: "set-curated-enabled"; extensionId: string; enabled: boolean }
  | { type: "set-development-enabled"; extensionId: string; enabled: boolean }
  | { type: "remove-development-entry"; extensionId: string };

export interface SaveDesktopExtensionSettingsInput {
  requestId: string;
  expectedRevision: string;
  mutation: DesktopExtensionSettingsMutation;
}

export interface ApproveDevelopmentExtensionInput {
  requestId: string;
  expectedRevision: string;
}

export type SaveDesktopExtensionSettingsResult =
  | { status: "saved"; snapshot: DesktopExtensionSettingsSnapshot }
  | { status: "conflict"; current: DesktopExtensionSettingsSnapshot }
  | { status: "cancelled"; snapshot: DesktopExtensionSettingsSnapshot };

export interface ApplyDesktopExtensionSetInput {
  projectId: string;
  threadId: string;
  expectedDesiredGeneration: string;
  abortRunning?: boolean;
}

export interface ApplyDesktopExtensionSetResult {
  status: "applied" | "rolled-back" | "unchanged";
  generation: string;
  error?: string;
}

export interface StaleDraftExtensionSetErrorDetails {
  code: "STALE_DRAFT_EXTENSION_SET";
  requestedGeneration: string;
  currentGeneration: string;
}

export interface DesktopExtensionCompatibilityErrorShape {
  code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE" | "DESKTOP_EXTENSION_HOST_DISPOSED";
  capability: string;
  message: string;
}
