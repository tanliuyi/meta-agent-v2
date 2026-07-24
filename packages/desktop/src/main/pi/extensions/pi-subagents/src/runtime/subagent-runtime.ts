import type {
  SubagentResumeRequest,
  SubagentRunEvent,
  SubagentRunRequest,
} from "../../../../../../shared/subagent-contracts.ts";

export type SubagentRuntimeRunRequest = Omit<SubagentRunRequest, "projectId" | "parentThreadId">;
export type SubagentRuntimeResumeRequest = Omit<SubagentResumeRequest, "projectId" | "parentThreadId">;

export interface SubagentRuntime {
  run(request: SubagentRuntimeRunRequest): AsyncIterable<SubagentRunEvent>;
  cancel(runId: string, childIndex: number): Promise<void>;
  steer(runId: string, childIndex: number, message: string): Promise<void>;
  resume(request: SubagentRuntimeResumeRequest): AsyncIterable<SubagentRunEvent>;
  dispose(): Promise<void>;
}
