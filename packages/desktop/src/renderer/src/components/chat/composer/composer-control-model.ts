import type { ModelOption } from "../../../../../shared/contracts.ts";
import {
  createModelSelectorOption,
  groupModelSelectorOptions,
} from "../../assistant-ui/model-selector/model-selector-options.ts";
import type { ModelOption as ModelSelectorOption } from "../../assistant-ui/model-selector/model-selector-types.ts";

/** 将 Pi 模型 identity 编码为 ModelSelector 的稳定 key。 */
export function composerModelKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

/** 一次构建模型选择器的展示列表、分组和 O(1) 反向索引。 */
export function createModelSelectorState(availableModels: readonly ModelOption[]) {
  const models: ModelSelectorOption[] = [];
  const modelByKey = new Map<string, ModelOption>();
  for (const model of availableModels) {
    const key = composerModelKey(model.provider, model.id);
    models.push(
      createModelSelectorOption({
        id: key,
        provider: model.provider,
        modelId: model.id,
        name: model.name,
      }),
    );
    modelByKey.set(key, model);
  }
  return { models, groups: groupModelSelectorOptions(models), modelByKey };
}
