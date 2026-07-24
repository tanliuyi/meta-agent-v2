// @ts-nocheck -- Vendored upstream module; Desktop boundary behavior is covered by focused tests.
import type { AgentScope } from "./agents.ts";

export function resolveExecutionAgentScope(scope: unknown): AgentScope {
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return "both";
}
