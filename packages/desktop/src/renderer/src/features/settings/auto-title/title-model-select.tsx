import { ModelSelectorContent } from "@renderer/components/assistant-ui/model-selector/model-selector-content";
import { ModelSelectorEmpty } from "@renderer/components/assistant-ui/model-selector/model-selector-empty";
import { ModelSelectorGroup } from "@renderer/components/assistant-ui/model-selector/model-selector-group";
import { ModelSelectorItem } from "@renderer/components/assistant-ui/model-selector/model-selector-item";
import { ModelSelectorList } from "@renderer/components/assistant-ui/model-selector/model-selector-list";
import {
  createModelSelectorOption,
  groupModelSelectorOptions,
} from "@renderer/components/assistant-ui/model-selector/model-selector-options";
import { ModelSelectorRoot } from "@renderer/components/assistant-ui/model-selector/model-selector-root";
import { ModelSelectorSearch } from "@renderer/components/assistant-ui/model-selector/model-selector-search";
import { ModelSelectorTrigger } from "@renderer/components/assistant-ui/model-selector/model-selector-trigger";
import type { ModelOption } from "@renderer/components/assistant-ui/model-selector/model-selector-types";
import { ModelSelectorValue } from "@renderer/components/assistant-ui/model-selector/model-selector-value";
import { useMemo } from "react";
import { type AutoTitleModelOption, autoTitleModelOptionId } from "../../../../../shared/auto-title-contracts.ts";

const INHERIT_SESSION_MODEL_ID = "";

const inheritOption: ModelOption = {
  id: INHERIT_SESSION_MODEL_ID,
  name: "继承当前会话模型",
  keywords: ["默认", "继承"],
};

interface TitleModelSelectProps {
  providerId: string;
  modelId: string;
  options: AutoTitleModelOption[];
  onChange(providerId: string, modelId: string): void;
}

function toModelOption(option: AutoTitleModelOption): ModelOption {
  return createModelSelectorOption({
    id: autoTitleModelOptionId(option),
    provider: option.provider,
    modelId: option.modelId,
    name: option.name,
  });
}

/** 从模型服务商已配置的提供商与模型中选择标题模型；空值表示继承当前会话模型。 */
export function TitleModelSelect({ providerId, modelId, options, onChange }: TitleModelSelectProps) {
  const selectedId = providerId && modelId ? autoTitleModelOptionId({ provider: providerId, modelId }) : "";

  const { models, groups, selectionMissing } = useMemo(() => {
    const modelOptions = options.map(toModelOption);
    const missing =
      selectedId.length > 0 && !modelOptions.some((option) => option.id === selectedId)
        ? {
            id: selectedId,
            name: `${selectedId}（当前配置，不在可选列表中）`,
          }
        : undefined;
    return { models: modelOptions, groups: groupModelSelectorOptions(modelOptions), selectionMissing: missing };
  }, [options, selectedId]);

  return (
    <ModelSelectorRoot
      models={[inheritOption, ...(selectionMissing ? [selectionMissing] : []), ...models]}
      value={selectedId}
      onValueChange={(value) => {
        if (value === INHERIT_SESSION_MODEL_ID) {
          onChange("", "");
          return;
        }
        const option = models.find((candidate) => candidate.id === value);
        if (!option) return;
        const [provider, ...rest] = value.split("/");
        onChange(provider, rest.join("/"));
      }}
    >
      <ModelSelectorTrigger className="min-w-72 rounded-xl" aria-label="标题模型">
        <ModelSelectorValue showEffort={false} placeholder="继承当前会话模型" />
      </ModelSelectorTrigger>
      <ModelSelectorContent align="start" sideOffset={6}>
        <ModelSelectorSearch placeholder="搜索模型..." />
        <ModelSelectorList>
          <ModelSelectorEmpty />
          <ModelSelectorGroup heading="默认">
            <ModelSelectorItem model={inheritOption} />
            {selectionMissing ? <ModelSelectorItem model={selectionMissing} /> : null}
          </ModelSelectorGroup>
          {[...groups].map(([provider, providerModels]) => (
            <ModelSelectorGroup key={provider} provider={provider} heading={provider}>
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
