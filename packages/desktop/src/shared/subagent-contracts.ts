import type { JsonValue, ThinkingLevel } from "./contracts.ts";
import type { DesktopExtensionDiagnostic } from "./desktop-extension-contracts.ts";

export const SUBAGENT_TIMEOUT_CODE = "SUBAGENT_TIMEOUT";

export type SubagentExtensionProfile = "provider" | "memory" | "runtime" | "fanout";

export interface SubagentRunAncestor {
  runId: string;
  childIndex: number;
}

export interface SubagentChildExtension {
  /** Trusted, Desktop-approved extension entry path. */
  path: string;
  /** Registered tool names that the child allowlist must expose. */
  tools: string[];
}

export interface SubagentRunRequest {
  projectId: string;
  parentThreadId: string;
  parentSessionId?: string;
  runId: string;
  rootRunId: string;
  childIndex: number;
  depth: number;
  maxDepth: number;
  lineage: SubagentRunAncestor[];
  agent: string;
  task: string;
  cwd: string;
  sessionFile?: string;
  sessionDir?: string;
  persistSession: boolean;
  /** Supervisor session target for child intercom coordination (contact_supervisor). */
  orchestratorTarget?: string;
  /** Stable child intercom session name announced to the orchestrator. */
  intercomSessionName?: string;
  model?: string;
  preferredProvider?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  extensionProfile: SubagentExtensionProfile[];
  childExtensions?: SubagentChildExtension[];
  timeoutMs?: number;
  turnBudget?: { maxTurns: number; graceTurns: number };
  toolBudget?: { hard: number; soft?: number; block: "*" | string[] };
  structuredOutput?: {
    schema: Record<string, JsonValue>;
    outputPath: string;
  };
}

export interface SubagentResumeRequest extends SubagentRunRequest {
  sessionFile: string;
}

/** Preserve Pi runtime event names end to end so upstream progress and transcript consumers share one protocol. */
export type SubagentRunEvent =
  | {
      type: "started";
      runId: string;
      threadId?: string;
      workerInstanceId?: string;
      sessionFile?: string;
      updatedAt?: number;
    }
  | { type: "message_update"; message: JsonValue; assistantMessageEvent: JsonValue }
  | { type: "message_end"; message: JsonValue; updatedAt?: number }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonValue }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: JsonValue }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: JsonValue; isError: boolean }
  | { type: "completed"; runId: string; sessionFile?: string; updatedAt?: number }
  | { type: "failed"; runId: string; error: string; code?: string; sessionFile?: string; updatedAt?: number };

export function subagentTextDelta(event: SubagentRunEvent): string | undefined {
  if (
    event.type !== "message_update" ||
    !event.assistantMessageEvent ||
    typeof event.assistantMessageEvent !== "object" ||
    Array.isArray(event.assistantMessageEvent)
  ) {
    return undefined;
  }
  return event.assistantMessageEvent.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string"
    ? event.assistantMessageEvent.delta
    : undefined;
}

export type SubagentWorkerBinding = {
  projectId: string;
  parentThreadId: string;
  runId: string;
  childIndex: number;
  agentDir: string;
  shellPath?: string;
};

export type SubagentWorkerCommand =
  | { type: "subagentRun"; request: SubagentRunRequest }
  | { type: "refreshModelConfiguration"; revision: { generation: number } }
  | { type: "subagentBootstrap" }
  | { type: "subagentCancel"; runId: string }
  | { type: "subagentSteer"; runId: string; message: string }
  | { type: "ping" };

export type SubagentHostRequest =
  | { type: "subagent.run"; request: SubagentRunRequest }
  | { type: "subagent.cancel"; projectId: string; parentThreadId: string; runId: string; childIndex: number }
  | {
      type: "subagent.steer";
      projectId: string;
      parentThreadId: string;
      runId: string;
      childIndex: number;
      message: string;
    };

export type SubagentHostResult = {
  status: "completed" | "failed" | "cancelled";
  sessionFile?: string;
  error?: string;
};

export type SubagentSettingsScope = "user" | "project";
export type SubagentSource = "builtin" | "user" | "project" | "package";

export interface SubagentTurnBudget {
  maxTurns: number;
  graceTurns?: number;
}

export interface SubagentToolBudget {
  hard: number;
  soft?: number;
  block?: string[] | "*";
}

export interface SubagentAgentConfigInput {
  name?: string;
  description?: string;
  package?: string | false;
  model?: string | false;
  fallbackModels?: string[] | false;
  thinking?: ThinkingLevel | false;
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork" | false;
  tools?: string[] | false;
  skills?: string[] | false;
  turnBudget?: SubagentTurnBudget | false;
  toolBudget?: SubagentToolBudget | false;
  acceptanceRole?: "read-only" | "writer" | false;
  completionGuard?: boolean;
  disabled?: boolean;
  async?: boolean;
  timeoutMs?: number | false;
}

export interface AgentSummary {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  source: SubagentSource;
  filePath: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: ThinkingLevel | false;
  systemPrompt: string;
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  disabled?: boolean;
  defaultAsync?: boolean;
  defaultTimeoutMs?: number;
  tools?: string[];
  mcpDirectTools?: string[];
  skills?: string[];
  turnBudget?: SubagentTurnBudget;
  toolBudget?: SubagentToolBudget;
  acceptanceRole?: "read-only" | "writer";
  completionGuard?: boolean;
  overridden?: boolean;
  overrideScope?: SubagentSettingsScope;
  baseModel?: string;
}

export interface ChainStepConfig {
  agent: string;
  task?: string;
  phase?: string;
  label?: string;
  output?: string | false;
  outputMode?: "inline" | "file-only";
  reads?: string[] | false;
  model?: string;
  skills?: string[] | false;
  progress?: boolean;
  toolBudget?: SubagentToolBudget;
}

export interface ChainSummary {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  source: Exclude<SubagentSource, "builtin">;
  filePath: string;
  steps: ChainStepConfig[];
  stepCount: number;
  editable: boolean;
  editBlockedReason?: string;
}

export interface SubagentModelOption {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
}

export interface SubagentSkillOption {
  name: string;
  source: string;
  description?: string;
}

export interface SubagentExtensionConfig {
  asyncByDefault?: boolean;
  asyncWidget?: boolean;
  maxSubagentDepth?: number;
  maxSubagentSpawnsPerSession?: number;
  globalConcurrencyLimit?: number;
  toolDescriptionMode?: "full" | "compact" | "custom";
  artifactDir?: "project" | "session" | "temp";
  scheduledRuns?: {
    enabled?: boolean;
    maxPending?: number;
    storeRoot?: string;
  };
  // 以下字段与上游 pi-subagents ExtensionConfig 对齐（fleetView/fleetViewPlacement/
  // fleetKeybindings 为 TUI 专属，GUI 不暴露）。
  legacyChainControls?: boolean;
  inlineToolDisplay?: "rich" | "summary";
  forceTopLevelAsync?: boolean;
  waitTool?: { enabled?: boolean };
  defaultSessionDir?: string;
  singleRunOutputBaseDir?: string;
  worktreeSetupHook?: string;
  worktreeSetupHookTimeoutMs?: number;
  worktreeBaseDir?: string;
  intercomBridge?: {
    mode?: "off" | "fork-only" | "always";
    instructionFile?: string;
    resultDelivery?: boolean;
  };
  proactiveSkillSubagents?: { enabled?: boolean; preferredAgent?: string } | false;
  missions?: { enabled?: boolean };
  authorityPolicy?: Partial<
    Record<
      "discardWorktree" | "destructiveCleanup" | "spawnBudgetGrant" | "scheduleCreate" | "stopRun" | "steerRun",
      "auto" | "confirm" | "forbid"
    >
  >;
  parallel?: { maxTasks?: number; concurrency?: number };
  chain?: { dynamicFanout?: { maxItems?: number } };
  turnBudget?: { maxTurns: number; graceTurns?: number };
  toolBudget?: { soft?: number; hard: number };
  control?: {
    enabled?: boolean;
    needsAttentionAfterMs?: number;
    activeNoticeAfterMs?: number;
  };
  completionBatch?: { enabled?: boolean; debounceMs?: number; maxWaitMs?: number };
  usageBudget?: {
    tokens?: { soft?: number; hard: number };
    costUsd?: { soft?: number; hard: number };
  };
  permissions?: { rules?: Record<string, "allow" | "ask" | "deny"> };
}

export interface SubagentWatchdogEndpointSettings {
  model?: string;
  thinking?: ThinkingLevel | false;
}

export interface SubagentWatchdogSettings {
  effective: {
    enabled: boolean;
    main: SubagentWatchdogEndpointSettings & { enabled: boolean };
    children: SubagentWatchdogEndpointSettings & { enabled: boolean };
  };
  inherited: {
    enabled: boolean;
    main: SubagentWatchdogEndpointSettings & { enabled: boolean };
    children: SubagentWatchdogEndpointSettings & { enabled: boolean };
  };
  override: {
    enabled?: boolean;
    main: SubagentWatchdogEndpointSettings & { enabled?: boolean };
    children: SubagentWatchdogEndpointSettings & { enabled?: boolean };
  };
}

export interface SubagentWatchdogConfigInput {
  enabled?: boolean | null;
  main?: {
    enabled?: boolean | null;
    model?: string | null;
    thinking?: ThinkingLevel | false | null;
  };
  children?: {
    enabled?: boolean | null;
    model?: string | null;
    thinking?: ThinkingLevel | false | null;
  };
}

export interface AgentModelSourceInfo {
  type: "subagents.defaultModel";
  scope: SubagentSettingsScope;
  path: string;
  model: string;
}

export interface SubagentSettingsSnapshot {
  revision: string;
  projectId?: string;
  projectScopeAvailable: boolean;
  extensionConfig: SubagentExtensionConfig;
  watchdog: SubagentWatchdogSettings;
  builtinAgents: AgentSummary[];
  packageAgents: AgentSummary[];
  userAgents: AgentSummary[];
  projectAgents: AgentSummary[];
  chains: ChainSummary[];
  models: SubagentModelOption[];
  skills: SubagentSkillOption[];
  defaultModel?: AgentModelSourceInfo;
  diagnostics: DesktopExtensionDiagnostic[];
}

export type SubagentSettingsMutation =
  | {
      type: "update-agent";
      agent: string;
      scope: SubagentSettingsScope;
      target?: "builtin" | "custom";
      config: SubagentAgentConfigInput;
    }
  | {
      type: "create-agent";
      scope: SubagentSettingsScope;
      config: SubagentAgentConfigInput & { name: string; description: string };
    }
  | { type: "delete-agent"; agent: string; scope: SubagentSettingsScope }
  | { type: "eject-agent"; agent: string; scope: SubagentSettingsScope }
  | {
      type: "set-agent-enabled";
      agent: string;
      disabled: boolean;
      scope?: SubagentSettingsScope;
    }
  | {
      type: "create-chain";
      scope: SubagentSettingsScope;
      config: { name: string; description: string; steps: ChainStepConfig[] };
    }
  | {
      type: "update-chain";
      chain: string;
      scope: SubagentSettingsScope;
      config: Partial<{ name: string; description: string; steps: ChainStepConfig[] }>;
    }
  | { type: "delete-chain"; chain: string; scope: SubagentSettingsScope }
  | {
      type: "update-watchdog-config";
      scope: SubagentSettingsScope;
      config: SubagentWatchdogConfigInput;
    }
  | { type: "update-extension-config"; config: Partial<SubagentExtensionConfig> };

export type SubagentSettingsTarget =
  | { settingsScope?: "user"; projectId?: undefined }
  | { settingsScope?: "project"; projectId: string }
  | { settingsScope: "system"; projectId?: undefined };

export type GetSubagentSettingsInput = SubagentSettingsTarget;

export type SaveSubagentSettingsInput = SubagentSettingsTarget & {
  requestId: string;
  expectedSnapshotRevision: string;
  mutation: SubagentSettingsMutation;
};

export type SaveSubagentSettingsResult =
  | { status: "saved"; snapshot: SubagentSettingsSnapshot }
  | { status: "conflict"; current: SubagentSettingsSnapshot };
