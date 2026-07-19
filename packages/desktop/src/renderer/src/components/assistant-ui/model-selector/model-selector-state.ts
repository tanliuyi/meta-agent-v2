import type { ModelOption, ModelSelectorEffortOption } from "./model-selector-types.ts";

export const DEFAULT_EFFORT_OPTIONS: readonly ModelSelectorEffortOption[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Med" },
  { id: "high", name: "High" },
];

export function getModelEfforts(model: ModelOption | undefined): readonly ModelSelectorEffortOption[] | undefined {
  if (!model?.efforts) return undefined;
  return model.efforts === true ? DEFAULT_EFFORT_OPTIONS : model.efforts;
}

export function resolveEffort(
  efforts: readonly ModelSelectorEffortOption[] | undefined,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined;
  return efforts?.some((option) => option.id === effort) ? effort : undefined;
}

export function resolveModelEffort(
  models: readonly ModelOption[],
  modelId: string | undefined,
  effort: string | undefined,
): string | undefined {
  return resolveEffort(getModelEfforts(models.find((model) => model.id === modelId)), effort);
}
