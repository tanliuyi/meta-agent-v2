import type {
  SubagentChildExtension,
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
  /** Child-only extensions approved by the Desktop host for this session. */
  getChildExtensions?(): readonly SubagentChildExtension[];
  dispose(): Promise<void>;
}

export function resolveChildExtensions(
  runtime: SubagentRuntime | undefined,
  options: { denyExtensions?: boolean; allowedTools?: readonly string[] } = {},
): SubagentChildExtension[] {
  if (!runtime?.getChildExtensions || options.denyExtensions) return [];
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const seen = new Set<string>();
  const result: SubagentChildExtension[] = [];
  for (const extension of runtime.getChildExtensions()) {
    if (!extension.path || seen.has(extension.path)) continue;
    const tools = [...new Set(extension.tools)].filter((tool) => !allowedTools || allowedTools.has(tool));
    if (tools.length === 0) continue;
    seen.add(extension.path);
    result.push({ path: extension.path, tools });
  }
  return result;
}

export function childExtensionTools(extensions: readonly SubagentChildExtension[]): string[] {
  return [...new Set(extensions.flatMap((extension) => extension.tools))];
}
