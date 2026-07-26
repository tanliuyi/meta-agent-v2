import type { JsonValue, ThinkingLevel } from "./contracts.ts";
import type { DesktopExtensionDiagnostic } from "./desktop-extension-contracts.ts";

export type SubagentExtensionProfile = "provider" | "memory" | "runtime" | "fanout";

export interface SubagentRunAncestor {
  runId: string;
  childIndex: number;
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
  model?: string;
  preferredProvider?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  extensionProfile: SubagentExtensionProfile[];
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

export type SubagentRunEvent =
  | { type: "started"; runId: string; workerInstanceId?: string }
  | { type: "text-delta"; text: string }
  | { type: "message-end"; message: JsonValue }
  | { type: "tool-start"; toolCallId: string; toolName: string; args: JsonValue }
  | { type: "tool-update"; toolCallId: string; toolName: string; partialResult: JsonValue }
  | { type: "tool-end"; toolCallId: string; toolName: string; result: JsonValue; isError: boolean }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  | { type: "completed"; runId: string; sessionFile?: string }
  | { type: "failed"; runId: string; error: string; code?: string; sessionFile?: string };

export type SubagentWorkerBinding = {
  projectId: string;
  parentThreadId: string;
  runId: string;
  childIndex: number;
  agentDir: string;
};

export type SubagentWorkerCommand =
  | { type: "subagentRun"; request: SubagentRunRequest }
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
    maxLatenessMs?: number;
    maxPending?: number;
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
  | { type: "update-extension-config"; config: Partial<SubagentExtensionConfig> };

export interface GetSubagentSettingsInput {
  projectId?: string;
}

export interface SaveSubagentSettingsInput {
  requestId: string;
  projectId?: string;
  expectedSnapshotRevision: string;
  mutation: SubagentSettingsMutation;
}

export type SaveSubagentSettingsResult =
  | { status: "saved"; snapshot: SubagentSettingsSnapshot }
  | { status: "conflict"; current: SubagentSettingsSnapshot };
