const CHILD_EXTENSION_REGISTRY = Symbol.for("meta-agent.desktop.subagent-child-extensions.v1");
const ACP_CHILD_TOOLS = ["compress", "decompress", "search_context", "acp_status"] as const;

interface ChildExtensionRegistration {
  path: string;
  tools: string[];
}

interface ChildExtensionRegistry {
  entries: Map<string, ChildExtensionRegistration>;
}

type GlobalWithRegistry = typeof globalThis & {
  [CHILD_EXTENSION_REGISTRY]?: ChildExtensionRegistry;
};

/**
 * Opt the loaded extension into Desktop's explicitly controlled child-session
 * extension set. The Desktop host filters this registry against its approved
 * parent extension set before anything crosses the sidecar boundary.
 */
export function registerAcpChildExtension(path: string): void {
  const globalState = globalThis as GlobalWithRegistry;
  const registry = globalState[CHILD_EXTENSION_REGISTRY] ?? { entries: new Map() };
  registry.entries.set(path, { path, tools: [...ACP_CHILD_TOOLS] });
  globalState[CHILD_EXTENSION_REGISTRY] = registry;
}
