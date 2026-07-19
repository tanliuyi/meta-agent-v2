import type { ModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import { Select } from "@renderer/components/assistant-ui/select/select";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { Input } from "@renderer/shared/ui/input";
import type { ModelsModelDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsCompatEditor } from "./models-compat-editor.tsx";
import { ModelsCostEditor, type ModelsCostValue } from "./models-cost-editor.tsx";
import { ModelsMapEditor } from "./models-map-editor.tsx";
import { ModelsThinkingMapEditor, type ModelsThinkingMapValue } from "./models-thinking-map-editor.tsx";

interface ModelsModelFormProps {
  model: ModelsModelDraft;
  metadata: ModelsConfigMetadata;
  onChange(model: ModelsModelDraft): void;
}

/** Structured editor for one custom model definition. */
export function ModelsModelForm({ model, metadata, onChange }: ModelsModelFormProps) {
  const updateConfig = (next: ModelsModelDraft["config"]) => onChange({ ...model, config: next });
  return (
    <div className="models-entity-form">
      <div className="models-form-grid">
        <label>
          <span>Model ID</span>
          <Input
            value={model.config.id}
            onChange={(event) => updateConfig({ ...model.config, id: event.target.value })}
          />
        </label>
        <label>
          <span>显示名称</span>
          <Input
            value={model.config.name ?? ""}
            onChange={(event) => updateConfig(setOptional(model.config, "name", event.target.value))}
          />
        </label>
        <label>
          <span>API</span>
          <div className="models-combo-row">
            <Input
              value={model.config.api ?? ""}
              onChange={(event) => updateConfig(setOptional(model.config, "api", event.target.value))}
            />
            <Select
              className="models-select models-suggestion-select"
              value={metadata.knownApis.includes(model.config.api ?? "") ? model.config.api! : "custom"}
              onValueChange={(nextValue) => {
                if (nextValue !== "custom") updateConfig({ ...model.config, api: nextValue });
              }}
              options={[
                { value: "custom", label: "自定义" },
                ...metadata.knownApis.map((api) => ({ value: api, label: api })),
              ]}
            />
          </div>
        </label>
        <label>
          <span>Base URL</span>
          <Input
            value={model.config.baseUrl ?? ""}
            onChange={(event) => updateConfig(setOptional(model.config, "baseUrl", event.target.value))}
          />
        </label>
        <label>
          <span>Context window</span>
          <Input
            type="number"
            min="1"
            value={model.config.contextWindow ?? ""}
            onChange={(event) => updateConfig(setOptionalNumber(model.config, "contextWindow", event.target.value))}
          />
        </label>
        <label>
          <span>Max tokens</span>
          <Input
            type="number"
            min="1"
            value={model.config.maxTokens ?? ""}
            onChange={(event) => updateConfig(setOptionalNumber(model.config, "maxTokens", event.target.value))}
          />
        </label>
        <label>
          <span>Reasoning</span>
          <Select
            className="models-select"
            value={model.config.reasoning === undefined ? "unset" : String(model.config.reasoning)}
            onValueChange={(nextValue) => updateConfig(setOptionalBoolean(model.config, "reasoning", nextValue))}
            options={[
              { value: "unset", label: "继承 / 默认" },
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
          />
        </label>
        <fieldset className="models-inline-fieldset">
          <legend>输入</legend>
          {(["text", "image"] as const).map((kind) => (
            <label className="models-inline-checkbox" key={kind}>
              <Checkbox
                checked={model.config.input?.includes(kind) ?? false}
                onCheckedChange={(checked) => {
                  const input = new Set(model.config.input ?? []);
                  if (checked === true) input.add(kind);
                  else input.delete(kind);
                  updateConfig({ ...model.config, input: input.size > 0 ? [...input] : undefined });
                }}
              />
              {kind}
            </label>
          ))}
        </fieldset>
      </div>
      <ModelsThinkingMapEditor
        value={model.config.thinkingLevelMap as ModelsThinkingMapValue | undefined}
        onChange={(thinkingLevelMap) => updateConfig({ ...model.config, thinkingLevelMap })}
      />
      <ModelsCostEditor
        value={model.config.cost as ModelsCostValue | undefined}
        requireBaseRates
        onChange={(cost) => updateConfig({ ...model.config, cost: cost as ModelsModelDraft["config"]["cost"] })}
      />
      <ModelsMapEditor
        label="Model headers"
        entries={model.headers}
        onChange={(headers) => onChange({ ...model, headers })}
      />
      <ModelsCompatEditor value={model.compat} onChange={(compat) => onChange({ ...model, compat })} />
    </div>
  );
}

function setOptional<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (!input) delete next[key];
  else next[key] = input as T[K];
  return next;
}

function setOptionalNumber<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (!input) delete next[key];
  else next[key] = Number(input) as T[K];
  return next;
}

function setOptionalBoolean<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (input === "unset") delete next[key];
  else next[key] = (input === "true") as T[K];
  return next;
}
