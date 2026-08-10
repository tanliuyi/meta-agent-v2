import type { SubagentChildExtension } from "../../../shared/subagent-contracts.ts";

const CHILD_EXTENSION_REGISTRY = Symbol.for("meta-agent.desktop.subagent-child-extensions.v1");

interface ChildExtensionRegistry {
  entries: Map<string, SubagentChildExtension>;
}

type GlobalWithRegistry = typeof globalThis & {
  [CHILD_EXTENSION_REGISTRY]?: ChildExtensionRegistry;
};

export function getRegisteredSubagentChildExtensions(): SubagentChildExtension[] {
  const registry = (globalThis as GlobalWithRegistry)[CHILD_EXTENSION_REGISTRY];
  if (!registry) return [];
  return [...registry.entries.values()].map((entry) => ({ path: entry.path, tools: [...entry.tools] }));
}
