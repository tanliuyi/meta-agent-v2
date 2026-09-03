import type { Static, TSchema } from "typebox";
import type { JsonValue } from "./contracts.ts";
import type { PluginConfigurationSchema, PluginConfigurationValue } from "./plugin-configuration-contracts.ts";

export const DESKTOP_EXTENSION_HOST_PROFILE_VERSION = 1 as const;

export type ExtensionScope = "global" | "project";

export interface PluginApiCatalogV1 {
  schemaVersion: 1;
  pluginId: string;
  methods: Array<{
    name: string;
    description: string;
    parameters: JsonObject;
    result: JsonObject;
    concurrency: "serial" | "parallel";
  }>;
}

export interface PluginMethodExecutionContext {
  readonly pluginId: string;
  readonly methodName: string;
  readonly callId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly toolContext?: unknown;
  attach(attachment: PluginMethodAttachment): void;
  reportProgress(progress: JsonValue): void;
}

export type PluginMethodAttachment =
  | { type: "image"; data: string; mimeType: string; name?: string }
  | { type: "file"; path: string; mimeType?: string; name?: string };

export interface DesktopPluginMethodDefinition<TParams extends TSchema = TSchema, TResult extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  result: TResult;
  concurrency?: "serial" | "parallel";
  execute(params: Static<TParams>, signal: AbortSignal, ctx: PluginMethodExecutionContext): Promise<Static<TResult>>;
}

export interface DesktopPluginModuleExport {
  schemaVersion: 1;
  methods: readonly DesktopPluginMethodDefinition[];
}

type JsonObject = { [key: string]: JsonValue };

export type DesktopExtensionCapability =
  | "events.subscribe"
  | "configuration.read"
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
  | "ui.terminal.input"
  | "plugin-methods.provide";

export type DesktopExtensionSource = "builtin" | "curated" | "marketplace" | "development";

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
  skillPaths?: string[];
  pluginCallSkill?: string;
  pluginCallCatalogPath?: string;
  pluginCallCatalogSha256?: string;
  pluginCallCatalog?: PluginApiCatalogV1;
}

export interface ResolvedExtensionEntry {
  id: string;
  displayName: string;
  source: DesktopExtensionSource;
  entryPath?: string;
  hostProfileVersion: typeof DESKTOP_EXTENSION_HOST_PROFILE_VERSION;
  capabilities: DesktopExtensionCapability[];
  configuration?: Record<string, PluginConfigurationValue>;
  /** development 插件声明的插件身份（market-manifest.json plugin.id）；与市场插件同 id 时本地优先。 */
  pluginId?: string;
  skillPaths?: string[];
  pluginCallSkill?: string;
  pluginCallCatalogPath?: string;
  pluginCallCatalogSha256?: string;
  pluginCallCatalog?: PluginApiCatalogV1;
}

export interface ResolvedExtensionSet {
  generation: string;
  projectId: string;
  entries: ResolvedExtensionEntry[];
  curatedRoot?: string;
  diagnostics: DesktopExtensionDiagnostic[];
  resolvedAt: number;
}

/** Composer 中可按会话激活的 direct-tool 插件；plugin_call 插件不包含在此列表中。 */
export interface DraftSelectablePlugin {
  id: string;
  displayName: string;
  source: "marketplace" | "development";
  /** 启用状态由插件中心全局决定；此字段表示当前项目/扩展集是否可用。 */
  available: boolean;
}

export interface DraftExtensionContext {
  extensionSetGeneration: string;
  diagnostics: DesktopExtensionDiagnostic[];
  /** 该项目当前可激活的插件（继承项目级作用域后的全集）。 */
  plugins: DraftSelectablePlugin[];
  /** 会话级激活子集；null 表示继承项目级（全部激活）。 */
  enabledPluginIds: string[] | null;
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
  working?: {
    message?: string;
    visible?: boolean;
  };
}

export interface DesktopExtensionListEntry {
  id: string;
  displayName: string;
  source: DesktopExtensionSource;
  enabled: boolean;
  configuredEnabled: boolean;
  capabilities: DesktopExtensionCapability[];
  displayPath?: string;
  configurationSchema?: PluginConfigurationSchema;
  /** 生效范围：global 对所有项目生效；project 仅对 projectIds 指定的项目生效。 */
  scope: ExtensionScope;
  projectIds?: string[];
  /** development 插件声明的插件身份（market-manifest.json plugin.id），用于识别与市场插件的覆盖关系。 */
  pluginId?: string;
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
  | { type: "set-development-scope"; extensionId: string; scope: ExtensionScope; projectIds?: string[] }
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

/** 会话级插件选择查询结果（已有会话，数据源为项目全量可构建条目）。 */
export interface SessionPluginOptions {
  plugins: DraftSelectablePlugin[];
  enabledPluginIds: string[] | null;
}

export interface ApplySessionPluginSelectionInput {
  projectId: string;
  threadId: string;
  /** 会话级激活子集；null 表示继承项目级（全部激活）。 */
  enabledPluginIds: string[] | null;
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
