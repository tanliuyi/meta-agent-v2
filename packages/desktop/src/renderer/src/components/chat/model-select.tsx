import { useMemo } from "react";
import type { ModelOption } from "../../../../shared/contracts.ts";
import { ModelSelectorContent } from "../assistant-ui/model-selector/model-selector-content.tsx";
import { ModelSelectorEmpty } from "../assistant-ui/model-selector/model-selector-empty.tsx";
import { ModelSelectorGroup } from "../assistant-ui/model-selector/model-selector-group.tsx";
import { ModelSelectorItem } from "../assistant-ui/model-selector/model-selector-item.tsx";
import { ModelSelectorList } from "../assistant-ui/model-selector/model-selector-list.tsx";
import { ModelSelectorRoot } from "../assistant-ui/model-selector/model-selector-root.tsx";
import { ModelSelectorSearch } from "../assistant-ui/model-selector/model-selector-search.tsx";
import { ModelSelectorTrigger } from "../assistant-ui/model-selector/model-selector-trigger.tsx";
import { ModelSelectorValue } from "../assistant-ui/model-selector/model-selector-value.tsx";
import { composerModelKey, createModelSelectorState } from "./composer-control-model.ts";

interface ModelSelectProps {
  availableModels: readonly ModelOption[];
  model: { provider: string; id: string } | null | undefined;
  disabled?: boolean;
  onValueChange(provider: string, modelId: string): void;
}

/** draft 与 committed session 共用的受控模型选择器。 */
export function ModelSelect({ availableModels, model, disabled = false, onValueChange }: ModelSelectProps) {
  const { models, groups, modelByKey } = useMemo(() => createModelSelectorState(availableModels), [availableModels]);
  const value = model ? composerModelKey(model.provider, model.id) : undefined;

  return (
    <ModelSelectorRoot
      models={models}
      value={value}
      onValueChange={(nextValue) => {
        const selected = modelByKey.get(nextValue);
        if (selected) onValueChange(selected.provider, selected.id);
      }}
    >
      <ModelSelectorTrigger variant="ghost" size="sm" aria-label="选择模型" disabled={disabled || models.length === 0}>
        <ModelSelectorValue showEffort={false} />
      </ModelSelectorTrigger>
      <ModelSelectorContent align="end">
        <ModelSelectorSearch placeholder="搜索模型..." />
        <ModelSelectorList>
          <ModelSelectorEmpty />
          {[...groups].map(([provider, providerModels]) => (
            <ModelSelectorGroup key={provider} heading={provider}>
              {providerModels.map((option) => (
                <ModelSelectorItem key={option.id} model={option} />
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
