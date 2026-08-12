import type { AgentConfig } from "../../agents/agents.ts";
import { resolveChildWatchdogConfig } from "../../watchdog/child-status.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { resolvePermissionRules, type PermissionConfig } from "./permissions.ts";

export interface ProgrammaticRuntimeCapabilityOptions {
  cwd: string;
  permissions?: PermissionConfig;
  allowIntercomDetach?: boolean;
}

export function canUseProgrammaticSubagentRuntime(
  agent: AgentConfig,
  options: ProgrammaticRuntimeCapabilityOptions,
): boolean {
  if (options.allowIntercomDetach) return false;
  if (agent.runner) return false;
  if (agent.extensions?.length || agent.subagentOnlyExtensions?.length || agent.mcpDirectTools?.length) return false;
  if (agent.tools?.some((tool) => tool.includes("/") || tool.includes("\\") || /\.[cm]?[jt]s$/i.test(tool))) return false;
  if (resolvePermissionRules(options.permissions, agent.permissions)) return false;

  const watchdog = resolveWatchdogConfig(options.cwd);
  if (!watchdog.ok) return false;
  return resolveChildWatchdogConfig({ config: watchdog.config, agent: agent.name }) === undefined;
}
