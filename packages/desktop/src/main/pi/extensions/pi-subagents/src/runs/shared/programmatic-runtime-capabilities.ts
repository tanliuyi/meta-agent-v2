import type { AgentConfig } from "../../agents/agents.ts";

/** Desktop programmatic workers support native Pi children, but foreground intercom requires detach. */
export function canUseProgrammaticSubagentRuntime(
  agent: AgentConfig,
  options: { cwd: string; permissions?: unknown; allowIntercomDetach: boolean },
): boolean {
  void options.cwd;
  void options.permissions;
  if (options.allowIntercomDetach && agent.tools?.includes("contact_supervisor")) return false;
  return agent.runner?.type !== "external-cli" && agent.runner?.type !== "external-job";
}
