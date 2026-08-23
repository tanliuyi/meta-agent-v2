import type { ContextUsage, PiThreadSnapshot } from "../../../../../shared/contracts.ts";

/** Pi message usage is the current request context total, not a session-wide cumulative total. */
export function selectLiveContextTokens(timeline: PiThreadSnapshot): number | undefined {
  if (timeline.phase !== "running") return undefined;

  for (let index = timeline.nodes.length - 1; index >= 0; index -= 1) {
    const node = timeline.nodes[index];
    if (!node || node.kind !== "assistant") continue;
    if (node.status.type === "incomplete") return undefined;
    const tokens =
      node.usage.totalTokens || node.usage.input + node.usage.output + node.usage.cacheRead + node.usage.cacheWrite;
    return tokens > 0 ? tokens : undefined;
  }
  return undefined;
}

export function resolveComposerContextUsage(
  authoritative: ContextUsage | undefined,
  liveTokens: number | undefined,
): ContextUsage | undefined {
  if (!authoritative || liveTokens === undefined) return authoritative;
  return {
    tokens: liveTokens,
    contextWindow: authoritative.contextWindow,
    percent: (liveTokens / authoritative.contextWindow) * 100,
  };
}
