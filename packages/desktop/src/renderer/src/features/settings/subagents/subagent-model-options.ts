import type { SubagentModelOption } from "../../../../../shared/subagent-contracts.ts";

export function groupSubagentModels(models: readonly SubagentModelOption[]): Map<string, SubagentModelOption[]> {
  const groups = new Map<string, SubagentModelOption[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return groups;
}
