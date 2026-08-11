import { modelSelectorIcon } from "./model-selector-icons.tsx";
import type { ModelOption } from "./model-selector-types.ts";

export interface ModelSelectorOptionSource {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  keywords?: readonly string[];
}

export function createModelSelectorOption(source: ModelSelectorOptionSource): ModelOption {
  return {
    id: source.id,
    name: source.name,
    provider: source.provider,
    description: source.modelId,
    icon: modelSelectorIcon(source.provider, source.modelId, source.name),
    keywords: [source.provider, source.modelId, ...(source.keywords ?? [])],
  };
}

export function groupModelSelectorOptions(options: readonly ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) {
    if (!option.provider) continue;
    const group = groups.get(option.provider);
    if (group) group.push(option);
    else groups.set(option.provider, [option]);
  }
  return groups;
}
