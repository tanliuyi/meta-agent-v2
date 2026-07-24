import type { JsonValue } from "./contracts.ts";

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
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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

export type SubagentHostResult = { status: "completed" | "failed" | "cancelled"; sessionFile?: string; error?: string };
