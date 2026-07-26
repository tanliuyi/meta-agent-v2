import { Select } from "@renderer/components/assistant-ui/select/select";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { Input } from "@renderer/shared/ui/input";
import { useRef, useState } from "react";
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
  const overrideRef = useRef(structuredClone(override));
  const [, rerenderDraft] = useState(0);
  const current = overrideRef.current;
  const emit = (next: ModelsModelOverrideDraft): void => {
    overrideRef.current = next;
    onChange(next);
  };
  const updateConfig = (config: ModelsModelOverrideDraft["config"], render = false): void => {
    emit({ ...overrideRef.current, config });
    if (render) rerenderDraft((revision) => revision + 1);
  };
  return (
    <div className="models-entity-form">
      <div className="models-form-grid">
        <label>
          <span>Model ID</span>
          <Input
            defaultValue={current.modelId}
            onChange={(event) => emit({ ...overrideRef.current, modelId: event.target.value })}
          />
        </label>
        <label>
          <span>显示名称</span>
          <Input
            defaultValue={current.config.name ?? ""}
            onChange={(event) => updateConfig(setOptional(overrideRef.current.config, "name", event.target.value))}
          />
        </label>
        <label>
          <span>Context window</span>
          <Input
            type="number"
            min="1"
            defaultValue={current.config.contextWindow ?? ""}
            onChange={(event) =>
              updateConfig(setOptionalNumber(overrideRef.current.config, "contextWindow", event.target.value))
            }
          />
        </label>
        <label>
          <span>Max tokens</span>
          <Input
            type="number"
            min="1"
            defaultValue={current.config.maxTokens ?? ""}
            onChange={(event) =>
              updateConfig(setOptionalNumber(overrideRef.current.config, "maxTokens", event.target.value))
            }
          />
        </label>
        <label>
          <span>Reasoning</span>
          <Select
            className="models-select"
            value={current.config.reasoning === undefined ? "unset" : String(current.config.reasoning)}
            onValueChange={(nextValue) =>
              updateConfig(setOptionalBoolean(overrideRef.current.config, "reasoning", nextValue), true)
            }
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
                defaultChecked={current.config.input?.includes(kind) ?? false}
                onCheckedChange={(checked) => {
                  const input = new Set(overrideRef.current.config.input ?? []);
                  if (checked === true) input.add(kind);
                  else input.delete(kind);
                  updateConfig({ ...overrideRef.current.config, input: input.size > 0 ? [...input] : undefined });
                }}
              />
              {kind}
            </label>
          ))}
        </fieldset>
      </div>
      <ModelsThinkingMapEditor
        value={current.config.thinkingLevelMap as ModelsThinkingMapValue | undefined}
        onChange={(thinkingLevelMap) => updateConfig({ ...overrideRef.current.config, thinkingLevelMap })}
      />
      <ModelsCostEditor
        value={current.config.cost as ModelsCostValue | undefined}
        onChange={(cost) =>
          updateConfig({
            ...overrideRef.current.config,
            cost: cost as ModelsModelOverrideDraft["config"]["cost"],
          })
        }
      />
      <ModelsMapEditor
        label="Override headers"
        entries={current.headers}
        onChange={(headers) => emit({ ...overrideRef.current, headers })}
      />
      <ModelsCompatEditor value={current.compat} onChange={(compat) => emit({ ...overrideRef.current, compat })} />
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
