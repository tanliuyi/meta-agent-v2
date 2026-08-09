import { ModelSelectorContent } from "@renderer/components/assistant-ui/model-selector/model-selector-content";
import { ModelSelectorEmpty } from "@renderer/components/assistant-ui/model-selector/model-selector-empty";
import { ModelSelectorGroup } from "@renderer/components/assistant-ui/model-selector/model-selector-group";
import { ModelSelectorItem } from "@renderer/components/assistant-ui/model-selector/model-selector-item";
import { ModelSelectorList } from "@renderer/components/assistant-ui/model-selector/model-selector-list";
import { ModelSelectorRoot } from "@renderer/components/assistant-ui/model-selector/model-selector-root";
import { ModelSelectorSearch } from "@renderer/components/assistant-ui/model-selector/model-selector-search";
import { ModelSelectorTrigger } from "@renderer/components/assistant-ui/model-selector/model-selector-trigger";
import type { ModelOption } from "@renderer/components/assistant-ui/model-selector/model-selector-types";
import { ModelSelectorValue } from "@renderer/components/assistant-ui/model-selector/model-selector-value";
import { useEffect, useMemo, useState } from "react";
import type { AutoTitleModelOption } from "../../../../shared/auto-title-contracts.ts";
import type { PluginConfigurationField } from "../../../../shared/plugin-configuration-contracts.ts";
import { PluginConfigurationFieldLabelRow } from "./plugin-configuration-field-label-row.tsx";
import type { PluginConfigurationController } from "./use-plugin-configuration.ts";

const AUTO_MODEL_ID = "";

type ModelFormat = "model-id" | "provider-model";

const autoModel: ModelOption = {
  id: AUTO_MODEL_ID,
  name: "自动选择",
  keywords: ["auto", "默认"],
};

export function PluginConfigurationModelSelector({
  field,
  controller,
}: {
  field: PluginConfigurationField;
  controller: PluginConfigurationController;
}) {
  const [availableModels, setAvailableModels] = useState<AutoTitleModelOption[]>([]);
  const id = `plugin-configuration-${field.key}`;
  const error = controller.fieldErrors.get(field.key);
  const descriptionId = field.description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  const value = String(controller.values[field.key] ?? "");
  const format: ModelFormat = field.modelFormat ?? "provider-model";

  useEffect(() => {
    let active = true;
    void window.desktop.autoTitle
      .getModelOptions()
      .then((options) => {
        if (active) setAvailableModels(options);
      })
      .catch(() => {
        if (active) setAvailableModels([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const { models, groups, selectedId, selectedMissing } = useMemo(() => {
    const modelOptions = availableModels.map(toModelOption);
    const selected = modelOptions.find((option) => matchesConfiguredValue(option, value, format));
    const missing =
      value.length > 0 && !selected
        ? {
            id: missingModelId(value),
            name: `${value}（当前配置）`,
            description: value,
            disabled: true,
          }
        : undefined;
    const groups = new Map<string, ModelOption[]>();
    for (let index = 0; index < modelOptions.length; index += 1) {
      const option = modelOptions[index]!;
      const provider = availableModels[index]!.provider;
      groups.set(provider, [...(groups.get(provider) ?? []), option]);
    }
    return {
      models: modelOptions,
      groups,
      selectedId: selected?.id ?? (missing ? missing.id : AUTO_MODEL_ID),
      selectedMissing: missing,
    };
  }, [availableModels, format, value]);

  return (
    <div className="plugin-configuration-field" data-deprecated={field.deprecated ? "true" : undefined}>
      <PluginConfigurationFieldLabelRow id={id} labelId={`${id}-label`} field={field} controller={controller} />
      {field.description ? <span id={descriptionId}>{field.description}</span> : null}
      <ModelSelectorRoot
        models={[autoModel, ...(selectedMissing ? [selectedMissing] : []), ...models]}
        value={selectedId}
        onValueChange={(selected) => {
          if (selected === AUTO_MODEL_ID) {
            controller.setValue(field.key, "");
            return;
          }
          const selectedModel = models.find((model) => model.id === selected);
          if (!selectedModel) return;
          controller.setValue(field.key, format === "model-id" ? modelIdFromSelectorId(selected) : selected);
        }}
      >
        <ModelSelectorTrigger
          id={id}
          className="plugin-configuration-select"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        >
          <ModelSelectorValue showEffort={false} placeholder="自动选择" />
        </ModelSelectorTrigger>
        <ModelSelectorContent align="start" sideOffset={6} searchable>
          <ModelSelectorSearch placeholder="搜索模型..." />
          <ModelSelectorList>
            <ModelSelectorEmpty>没有可用模型</ModelSelectorEmpty>
            <ModelSelectorGroup heading="默认">
              <ModelSelectorItem model={autoModel} />
              {selectedMissing ? <ModelSelectorItem model={selectedMissing} /> : null}
            </ModelSelectorGroup>
            {[...groups].map(([provider, providerModels]) => (
              <ModelSelectorGroup key={provider} heading={provider}>
                {providerModels.map((model) => (
                  <ModelSelectorItem key={model.id} model={model} />
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelectorRoot>
      {error ? (
        <span id={errorId} className="plugin-configuration-field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function toModelOption(option: AutoTitleModelOption): ModelOption {
  return {
    id: `${option.provider}/${option.modelId}`,
    name: option.name,
    description: option.modelId,
    keywords: [option.provider, option.modelId],
  };
}

function matchesConfiguredValue(option: ModelOption, value: string, format: ModelFormat): boolean {
  if (format === "provider-model") return option.id === value;
  return modelIdFromSelectorId(option.id) === value;
}

function modelIdFromSelectorId(value: string): string {
  const separator = value.indexOf("/");
  return separator >= 0 ? value.slice(separator + 1) : value;
}

function missingModelId(value: string): string {
  return `configured:${value}`;
}
