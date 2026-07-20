import type { ModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import * as Tabs from "@radix-ui/react-tabs";
import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { ScrollArea } from "@renderer/shared/ui/scroll-area";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useState } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsCompatEditor } from "./models-compat-editor.tsx";
import { ModelsMapEditor } from "./models-map-editor.tsx";
import { ModelsModelForm } from "./models-model-form.tsx";
import { ModelsOverrideForm } from "./models-override-form.tsx";
import { createModelDraft, createModelOverrideDraft } from "./models-settings-model.ts";

interface ModelsProviderFormProps {
  provider: ModelsProviderDraft;
  metadata: ModelsConfigMetadata;
  onChange(provider: ModelsProviderDraft): void;
  onDelete(): void;
}

/** Provider detail workbench with connection, models, overrides, and compat tabs. */
export function ModelsProviderForm({ provider, metadata, onChange, onDelete }: ModelsProviderFormProps) {
  const [selectedModel, setSelectedModel] = useState(0);
  const [selectedOverride, setSelectedOverride] = useState(0);
  const [newModelId, setNewModelId] = useState("");
  const [newOverrideId, setNewOverrideId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<"provider" | "model" | "override">();
  const builtIn = metadata.builtInProviders.find((item) => item.id === provider.key);

  useEffect(() => {
    setSelectedModel((current) => Math.max(0, Math.min(current, provider.models.length - 1)));
    setSelectedOverride((current) => Math.max(0, Math.min(current, provider.modelOverrides.length - 1)));
  }, [provider.models.length, provider.modelOverrides.length]);

  const updateConfig = (config: ModelsProviderDraft["config"]) => onChange({ ...provider, config });
  return (
    <div className="models-provider-detail">
      <header className="models-provider-heading">
        <div>
          <h2>{provider.config.name || builtIn?.displayName || provider.key || "未命名 Provider"}</h2>
          <span>{builtIn ? "Built-in override" : "Custom provider"}</span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          title="删除 Provider"
          aria-label="删除 Provider"
          onClick={() => setDeleteTarget("provider")}
        >
          <Trash2 />
        </Button>
      </header>

      <Tabs.Root className="models-tabs" defaultValue="connection">
        <Tabs.List className="models-tab-list" aria-label="Provider 配置">
          <Tabs.Trigger value="connection">连接</Tabs.Trigger>
          <Tabs.Trigger value="models">模型</Tabs.Trigger>
          <Tabs.Trigger value="overrides">模型覆盖</Tabs.Trigger>
          <Tabs.Trigger value="compat">兼容性</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="connection" className="models-tab-content">
          <ScrollArea className="models-tab-scroll">
            <div className="models-tab-scroll-content">
              <div className="models-form-grid">
                <label>
                  <span>Provider ID</span>
                  <Input
                    value={provider.key}
                    onChange={(event) => onChange({ ...provider, key: event.target.value })}
                  />
                </label>
                <label>
                  <span>显示名称</span>
                  <Input
                    value={provider.config.name ?? ""}
                    onChange={(event) => updateConfig(setOptional(provider.config, "name", event.target.value))}
                  />
                </label>
                <label>
                  <span>Base URL</span>
                  <Input
                    value={provider.config.baseUrl ?? ""}
                    placeholder="http://localhost:11434/v1"
                    onChange={(event) => updateConfig(setOptional(provider.config, "baseUrl", event.target.value))}
                  />
                </label>
                <label>
                  <span>API</span>
                  <div className="models-combo-row">
                    <Input
                      value={provider.config.api ?? ""}
                      onChange={(event) => updateConfig(setOptional(provider.config, "api", event.target.value))}
                    />
                    <Select
                      className="models-select models-suggestion-select"
                      value={metadata.knownApis.includes(provider.config.api ?? "") ? provider.config.api! : "custom"}
                      onValueChange={(nextValue) => {
                        if (nextValue !== "custom") updateConfig({ ...provider.config, api: nextValue });
                      }}
                      options={[
                        { value: "custom", label: "自定义" },
                        ...metadata.knownApis.map((api) => ({ value: api, label: api })),
                      ]}
                    />
                  </div>
                </label>
                <label>
                  <span>API key</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={provider.config.apiKey ?? ""}
                    placeholder="literal、$ENV 或 !command"
                    onChange={(event) => updateConfig({ ...provider.config, apiKey: event.target.value })}
                  />
                </label>
                <label>
                  <span>OAuth</span>
                  <Select
                    className="models-select"
                    value={provider.config.oauth ?? "unset"}
                    onValueChange={(nextValue) =>
                      updateConfig(setOptional(provider.config, "oauth", nextValue === "unset" ? "" : nextValue))
                    }
                    options={[
                      { value: "unset", label: "未设置" },
                      { value: "radius", label: "radius" },
                    ]}
                  />
                </label>
                <label>
                  <span>Authorization header</span>
                  <Select
                    className="models-select"
                    value={provider.config.authHeader === undefined ? "unset" : String(provider.config.authHeader)}
                    onValueChange={(nextValue) =>
                      updateConfig(setOptionalBoolean(provider.config, "authHeader", nextValue))
                    }
                    options={[
                      { value: "unset", label: "未设置" },
                      { value: "true", label: "true" },
                      { value: "false", label: "false" },
                    ]}
                  />
                </label>
              </div>
              <ModelsMapEditor
                label="Provider headers"
                entries={provider.headers}
                onChange={(headers) => onChange({ ...provider, headers })}
              />
            </div>
          </ScrollArea>
        </Tabs.Content>
        <Tabs.Content value="models" className="models-tab-content">
          <div className="models-entity-toolbar">
            <Input
              value={newModelId}
              placeholder="新 Model ID"
              onChange={(event) => setNewModelId(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!newModelId.trim()}
              onClick={() => {
                const models = [...provider.models, createModelDraft(newModelId.trim())];
                onChange({ ...provider, models });
                setSelectedModel(models.length - 1);
                setNewModelId("");
              }}
            >
              <Plus />
              添加模型
            </Button>
          </div>
          <div className="models-entity-workbench">
            <div className="models-entity-list" role="listbox" aria-label="自定义模型">
              {provider.models.map((model, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedModel}
                  data-active={index === selectedModel || undefined}
                  key={`${model.origin?.modelIndex ?? "new"}-${index}`}
                  onClick={() => setSelectedModel(index)}
                >
                  <span>{model.config.name || model.config.id}</span>
                  <small>{model.config.id}</small>
                </button>
              ))}
            </div>
            <ScrollArea className="models-entity-scroll">
              <div className="models-entity-detail">
                {provider.models[selectedModel] ? (
                  <>
                    <div className="models-inline-actions models-entity-delete">
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget("model")}>
                        <Trash2 />
                        删除模型
                      </Button>
                    </div>
                    <ModelsModelForm
                      model={provider.models[selectedModel]}
                      metadata={metadata}
                      onChange={(model) => {
                        const models = [...provider.models];
                        models[selectedModel] = model;
                        onChange({ ...provider, models });
                      }}
                    />
                  </>
                ) : (
                  <p className="models-empty-detail">添加模型后在此配置。</p>
                )}
              </div>
            </ScrollArea>
          </div>
        </Tabs.Content>
        <Tabs.Content value="overrides" className="models-tab-content">
          <div className="models-entity-toolbar">
            <Input
              value={newOverrideId}
              placeholder="要覆盖的 Model ID"
              onChange={(event) => setNewOverrideId(event.target.value)}
            />
            <Select
              className="models-select models-suggestion-select"
              value={builtIn?.models.some((model) => model.id === newOverrideId) ? newOverrideId : "custom"}
              onValueChange={(nextValue) => {
                if (nextValue !== "custom") setNewOverrideId(nextValue);
              }}
              options={[
                { value: "custom", label: "自定义 ID" },
                ...(builtIn?.models.map((model) => ({ value: model.id, label: model.name })) ?? []),
              ]}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!newOverrideId.trim()}
              onClick={() => {
                const modelOverrides = [...provider.modelOverrides, createModelOverrideDraft(newOverrideId.trim())];
                onChange({ ...provider, modelOverrides });
                setSelectedOverride(modelOverrides.length - 1);
                setNewOverrideId("");
              }}
            >
              <Plus />
              添加覆盖
            </Button>
          </div>
          <div className="models-entity-workbench">
            <div className="models-entity-list" role="listbox" aria-label="模型覆盖">
              {provider.modelOverrides.map((override, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedOverride}
                  data-active={index === selectedOverride || undefined}
                  key={`${override.origin?.modelId ?? "new"}-${index}`}
                  onClick={() => setSelectedOverride(index)}
                >
                  <span>{override.config.name || override.modelId}</span>
                  <small>{override.modelId}</small>
                </button>
              ))}
            </div>
            <ScrollArea className="models-entity-scroll">
              <div className="models-entity-detail">
                {provider.modelOverrides[selectedOverride] ? (
                  <>
                    <div className="models-inline-actions models-entity-delete">
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget("override")}>
                        <Trash2 />
                        删除覆盖
                      </Button>
                    </div>
                    <ModelsOverrideForm
                      override={provider.modelOverrides[selectedOverride]}
                      onChange={(override) => {
                        const modelOverrides = [...provider.modelOverrides];
                        modelOverrides[selectedOverride] = override;
                        onChange({ ...provider, modelOverrides });
                      }}
                    />
                  </>
                ) : (
                  <p className="models-empty-detail">添加覆盖后在此配置。</p>
                )}
              </div>
            </ScrollArea>
          </div>
        </Tabs.Content>
        <Tabs.Content value="compat" className="models-tab-content">
          <ScrollArea className="models-tab-scroll">
            <div className="models-tab-scroll-content">
              <ModelsCompatEditor value={provider.compat} onChange={(compat) => onChange({ ...provider, compat })} />
            </div>
          </ScrollArea>
        </Tabs.Content>
      </Tabs.Root>

      <ConfirmDialog
        open={deleteTarget !== undefined}
        title={deleteTitle(deleteTarget, builtIn !== undefined)}
        description="此操作会从 models.json 中移除对应配置。"
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        onConfirm={() => {
          if (deleteTarget === "provider") onDelete();
          else if (deleteTarget === "model") {
            onChange({ ...provider, models: provider.models.filter((_, index) => index !== selectedModel) });
          } else if (deleteTarget === "override") {
            onChange({
              ...provider,
              modelOverrides: provider.modelOverrides.filter((_, index) => index !== selectedOverride),
            });
          }
          setDeleteTarget(undefined);
        }}
      />
    </div>
  );
}

function deleteTitle(target: "provider" | "model" | "override" | undefined, builtIn: boolean): string {
  if (target === "provider") return builtIn ? "移除 built-in provider 覆盖？" : "删除 Provider？";
  if (target === "model") return "删除自定义模型？";
  return "删除模型覆盖？";
}

function setOptional<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (!input) delete next[key];
  else next[key] = input as T[K];
  return next;
}

function setOptionalBoolean<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (input === "unset") delete next[key];
  else next[key] = (input === "true") as T[K];
  return next;
}
