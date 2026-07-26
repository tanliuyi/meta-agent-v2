import type { ModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import { Select } from "@renderer/components/assistant-ui/select/select";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { Input } from "@renderer/shared/ui/input";
import { useRef, useState } from "react";
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
  const modelRef = useRef(structuredClone(model));
  const [, rerenderDraft] = useState(0);
  const current = modelRef.current;
  const emit = (next: ModelsModelDraft): void => {
    modelRef.current = next;
    onChange(next);
  };
  const updateConfig = (next: ModelsModelDraft["config"], render = false): void => {
    emit({ ...modelRef.current, config: next });
    if (render) rerenderDraft((revision) => revision + 1);
  };
  return (
    <div className="models-entity-form">
      <fieldset className="models-fieldset models-model-basics">
        <legend>基础配置</legend>
        <div className="models-form-grid">
          <label>
            <span>模型 ID</span>
            <Input
              defaultValue={current.config.id}
              onChange={(event) => updateConfig({ ...modelRef.current.config, id: event.target.value })}
            />
          </label>
          <label>
            <span>显示名称</span>
            <Input
              defaultValue={current.config.name ?? ""}
              onChange={(event) => updateConfig(setOptional(modelRef.current.config, "name", event.target.value))}
            />
          </label>
          <label>
            <span>API 类型</span>
            <div className="models-combo-row">
              <Input
                key={current.config.api ?? ""}
                defaultValue={current.config.api ?? ""}
                onChange={(event) => updateConfig(setOptional(modelRef.current.config, "api", event.target.value))}
              />
              <Select
                className="models-select models-suggestion-select"
                value={metadata.knownApis.includes(current.config.api ?? "") ? current.config.api! : "custom"}
                onValueChange={(nextValue) => {
                  if (nextValue !== "custom") updateConfig({ ...modelRef.current.config, api: nextValue }, true);
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
              defaultValue={current.config.baseUrl ?? ""}
              onChange={(event) => updateConfig(setOptional(modelRef.current.config, "baseUrl", event.target.value))}
            />
          </label>
          <label>
            <span>上下文窗口</span>
            <Input
              type="number"
              min="1"
              defaultValue={current.config.contextWindow ?? ""}
              onChange={(event) =>
                updateConfig(setOptionalNumber(modelRef.current.config, "contextWindow", event.target.value))
              }
            />
          </label>
          <label>
            <span>最大输出 tokens</span>
            <Input
              type="number"
              min="1"
              defaultValue={current.config.maxTokens ?? ""}
              onChange={(event) =>
                updateConfig(setOptionalNumber(modelRef.current.config, "maxTokens", event.target.value))
              }
            />
          </label>
          <label>
            <span>推理能力</span>
            <Select
              className="models-select"
              value={current.config.reasoning === undefined ? "unset" : String(current.config.reasoning)}
              onValueChange={(nextValue) =>
                updateConfig(setOptionalBoolean(modelRef.current.config, "reasoning", nextValue), true)
              }
              options={[
                { value: "unset", label: "继承 / 默认" },
                { value: "true", label: "支持" },
                { value: "false", label: "不支持" },
              ]}
            />
          </label>
          <fieldset className="models-inline-fieldset">
            <legend>输入类型</legend>
            {(["text", "image"] as const).map((kind) => (
              <label className="models-inline-checkbox" key={kind}>
                <Checkbox
                  defaultChecked={current.config.input?.includes(kind) ?? false}
                  onCheckedChange={(checked) => {
                    const input = new Set(modelRef.current.config.input ?? []);
                    if (checked === true) input.add(kind);
                    else input.delete(kind);
                    updateConfig({ ...modelRef.current.config, input: input.size > 0 ? [...input] : undefined });
                  }}
                />
                {kind === "text" ? "文本" : "图片"}
              </label>
            ))}
          </fieldset>
        </div>
      </fieldset>
      <ModelsThinkingMapEditor
        value={current.config.thinkingLevelMap as ModelsThinkingMapValue | undefined}
        onChange={(thinkingLevelMap) => updateConfig({ ...modelRef.current.config, thinkingLevelMap })}
      />
      <ModelsCostEditor
        value={current.config.cost as ModelsCostValue | undefined}
        requireBaseRates
        onChange={(cost) =>
          updateConfig({ ...modelRef.current.config, cost: cost as ModelsModelDraft["config"]["cost"] })
        }
      />
      <ModelsMapEditor
        label="请求头"
        entries={current.headers}
        onChange={(headers) => emit({ ...modelRef.current, headers })}
      />
      <ModelsCompatEditor value={current.compat} onChange={(compat) => emit({ ...modelRef.current, compat })} />
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
