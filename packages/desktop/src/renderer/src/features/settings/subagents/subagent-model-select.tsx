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
import type { SubagentModelOption } from "../../../../../shared/subagent-contracts.ts";

interface SubagentModelSelectProps {
  models: readonly SubagentModelOption[];
  value: string;
  /** 继承（默认）选项的值，如 "" 或 "inherit"。 */
  inheritValue: string;
  /** 继承选项的显示名，如「继承当前会话模型」。 */
  inheritName: string;
  /** 附加在继承选项名后的动态说明，如「当前会话模型」。 */
  inheritDetail?: string;
  controlId?: string;
  labelId?: string;
  className?: string;
  onValueChange(value: string): void;
}

function toModelOption(option: SubagentModelOption): ModelOption {
  const modelId = option.id.startsWith(`${option.provider}/`) ? option.id.slice(option.provider.length + 1) : option.id;
  return createModelSelectorOption({
    id: option.id,
    provider: option.provider,
    modelId,
    name: option.name,
  });
}

/** 子智能体模型选择：按服务商分组，带搜索，支持「继承」选项。 */
export function SubagentModelSelect({
  models,
  value,
  inheritValue,
  inheritName,
  inheritDetail,
  controlId,
  labelId,
  className = "w-full rounded-xl",
  onValueChange,
}: SubagentModelSelectProps) {
  const { options, groups } = useMemo(() => {
    const modelOptions = models.map(toModelOption);
    return { options: modelOptions, groups: groupModelSelectorOptions(modelOptions) };
  }, [models]);
  const inherit = useMemo<ModelOption>(
    () => ({
      id: inheritValue,
      name: inheritDetail ? `${inheritName}（${inheritDetail}）` : inheritName,
      keywords: ["继承", "默认"],
    }),
    [inheritValue, inheritName, inheritDetail],
  );

  return (
    <ModelSelectorRoot models={[inherit, ...options]} value={value} onValueChange={onValueChange}>
      <ModelSelectorTrigger id={controlId} aria-labelledby={labelId} aria-label={inheritName} className={className}>
        <ModelSelectorValue showEffort={false} placeholder={inheritName} />
      </ModelSelectorTrigger>
      <ModelSelectorContent align="start" sideOffset={6}>
        <ModelSelectorSearch placeholder="搜索模型..." />
        <ModelSelectorList>
          <ModelSelectorEmpty />
          <ModelSelectorGroup heading="默认">
            <ModelSelectorItem model={inherit} />
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
