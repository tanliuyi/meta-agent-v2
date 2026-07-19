import { Select } from "@renderer/components/assistant-ui/select/select";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { Input } from "@renderer/shared/ui/input";
import type { ModelsModelOverrideDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsCompatEditor } from "./models-compat-editor.tsx";
import { ModelsCostEditor, type ModelsCostValue } from "./models-cost-editor.tsx";
import { ModelsMapEditor } from "./models-map-editor.tsx";
import { ModelsThinkingMapEditor, type ModelsThinkingMapValue } from "./models-thinking-map-editor.tsx";

interface ModelsOverrideFormProps {
  override: ModelsModelOverrideDraft;
  onChange(override: ModelsModelOverrideDraft): void;
}

/** Structured editor for one partial built-in model override. */
export function ModelsOverrideForm({ override, onChange }: ModelsOverrideFormProps) {
  const updateConfig = (config: ModelsModelOverrideDraft["config"]) => onChange({ ...override, config });
  return (
    <div className="models-entity-form">
      <div className="models-form-grid">
        <label>
          <span>Model ID</span>
          <Input
            value={override.modelId}
            onChange={(event) => onChange({ ...override, modelId: event.target.value })}
          />
        </label>
        <label>
          <span>显示名称</span>
          <Input
            value={override.config.name ?? ""}
            onChange={(event) => updateConfig(setOptional(override.config, "name", event.target.value))}
          />
        </label>
        <label>
          <span>Context window</span>
          <Input
            type="number"
            min="1"
            value={override.config.contextWindow ?? ""}
            onChange={(event) => updateConfig(setOptionalNumber(override.config, "contextWindow", event.target.value))}
          />
        </label>
        <label>
          <span>Max tokens</span>
          <Input
            type="number"
            min="1"
            value={override.config.maxTokens ?? ""}
            onChange={(event) => updateConfig(setOptionalNumber(override.config, "maxTokens", event.target.value))}
          />
        </label>
        <label>
          <span>Reasoning</span>
          <Select
            className="models-select"
            value={override.config.reasoning === undefined ? "unset" : String(override.config.reasoning)}
            onValueChange={(nextValue) => updateConfig(setOptionalBoolean(override.config, "reasoning", nextValue))}
            options={[
              { value: "unset", label: "未设置" },
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
                checked={override.config.input?.includes(kind) ?? false}
                onCheckedChange={(checked) => {
                  const input = new Set(override.config.input ?? []);
                  if (checked === true) input.add(kind);
                  else input.delete(kind);
                  updateConfig({ ...override.config, input: input.size > 0 ? [...input] : undefined });
                }}
              />
              {kind}
            </label>
          ))}
        </fieldset>
      </div>
      <ModelsThinkingMapEditor
        value={override.config.thinkingLevelMap as ModelsThinkingMapValue | undefined}
        onChange={(thinkingLevelMap) => updateConfig({ ...override.config, thinkingLevelMap })}
      />
      <ModelsCostEditor
        value={override.config.cost as ModelsCostValue | undefined}
        onChange={(cost) =>
          updateConfig({ ...override.config, cost: cost as ModelsModelOverrideDraft["config"]["cost"] })
        }
      />
      <ModelsMapEditor
        label="Override headers"
        entries={override.headers}
        onChange={(headers) => onChange({ ...override, headers })}
      />
      <ModelsCompatEditor value={override.compat} onChange={(compat) => onChange({ ...override, compat })} />
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
