import type { ModelOption, SessionControlState } from "../../../../shared/contracts.ts";
import type { ModelOption as ModelSelectorOption } from "../assistant-ui/model-selector/model-selector-types.ts";

const THINKING_LEVEL_LABELS: Record<SessionControlState["thinkingLevel"], string> = {
  off: "关",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** 将 Pi 模型 identity 编码为 ModelSelector 的稳定 key。 */
export function composerModelKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

/** 返回 thinking level 的紧凑中文标签。 */
export function getThinkingLevelLabel(level: SessionControlState["thinkingLevel"]): string {
  return THINKING_LEVEL_LABELS[level];
}

/** 一次构建模型选择器的展示列表、分组和 O(1) 反向索引。 */
export function createModelSelectorState(availableModels: readonly ModelOption[]) {
  const models: ModelSelectorOption[] = [];
  const groups = new Map<string, ModelSelectorOption[]>();
  const modelByKey = new Map<string, ModelOption>();
  for (const model of availableModels) {
    const key = composerModelKey(model.provider, model.id);
    const option: ModelSelectorOption = {
      id: key,
      name: model.name,
      description: model.id,
      keywords: [model.provider],
    };
    models.push(option);
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), option]);
    modelByKey.set(key, model);
  }
  return { models, groups, modelByKey };
}
