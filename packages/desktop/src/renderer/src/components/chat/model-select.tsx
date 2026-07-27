import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
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
import { composerModelKey, createModelSelectorState } from "./composer/composer-control-model.ts";

interface ModelSelectProps {
  availableModels: readonly ModelOption[];
  model: { provider: string; id: string } | null | undefined;
  disabled?: boolean;
  loading?: boolean;
  onOpen?(): void;
  onValueChange(provider: string, modelId: string): void;
}

/** draft 与 committed session 共用的受控模型选择器。 */
export function ModelSelect({
  availableModels,
  model,
  disabled = false,
  loading = false,
  onOpen,
  onValueChange,
}: ModelSelectProps) {
  const { models, groups, modelByKey } = useMemo(() => createModelSelectorState(availableModels), [availableModels]);
  const value = model ? composerModelKey(model.provider, model.id) : undefined;

  return (
    <ModelSelectorRoot
      models={models}
      value={value}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
      onValueChange={(nextValue) => {
        const selected = modelByKey.get(nextValue);
        if (selected) onValueChange(selected.provider, selected.id);
      }}
    >
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        aria-label={loading ? "正在加载模型" : "选择模型"}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
      >
        {loading ? (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground" role="status">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            <span>加载模型</span>
          </span>
        ) : (
          <ModelSelectorValue showEffort={false} />
        )}
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
