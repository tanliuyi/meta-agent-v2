import type { AgentConfig } from "../../agents/agents.ts";
import { resolveChildWatchdogConfig } from "../../watchdog/child-status.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { resolvePermissionRules, type PermissionConfig } from "./permissions.ts";

export interface ProgrammaticRuntimeCapabilityOptions {
  cwd: string;
  permissions?: PermissionConfig;
  /**
   * True when the run may need the CLI-only parent-detach mechanism: a blocking
   * child supervisor request (contact_supervisor/intercom) must release the
   * orchestrating session so it can reply. Programmatic workers coordinate
   * intercom through the Desktop supervisor channel instead, so runs that need
   * parent detach keep the detached CLI fallback.
   */
  allowIntercomDetach?: boolean;
}

export function canUseProgrammaticSubagentRuntime(
  agent: AgentConfig,
  options: ProgrammaticRuntimeCapabilityOptions,
): boolean {
  if (options.allowIntercomDetach) return false;
  // Intercom bridge activation alone is not a capability gap: programmatic
  // workers register the child contact_supervisor/intercom tools and share the
  // supervisor channel with the orchestrating session. Only the parent-detach
  // mechanism (above) remains CLI-only.
  if (agent.runner) return false;
  if (agent.extensions?.length || agent.subagentOnlyExtensions?.length || agent.mcpDirectTools?.length) return false;
  if (agent.tools?.some((tool) => tool.includes("/") || tool.includes("\\") || /\.[cm]?[jt]s$/i.test(tool))) return false;
  if (resolvePermissionRules(options.permissions, agent.permissions)) return false;

  const watchdog = resolveWatchdogConfig(options.cwd);
  if (!watchdog.ok) return false;
  return resolveChildWatchdogConfig({ config: watchdog.config, agent: agent.name }) === undefined;
}
