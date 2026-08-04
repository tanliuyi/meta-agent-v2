import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useRef, useState } from "react";
import type { ModelsModelDraft, ModelsProviderDraft } from "../../../../../shared/models-config-contracts.ts";
import type {
  ProviderBuiltInModelMetadata,
  ProvidersConfigMetadata,
} from "../../../../../shared/providers-config-contracts.ts";
import { ModelsModelForm } from "./models-model-form.tsx";
import { createModelDraft } from "./models-settings-model.ts";
import { ProviderBuiltInModelDetail } from "./provider-built-in-model-detail.tsx";

interface ProviderModelsTabProps {
  provider?: ModelsProviderDraft;
  metadata: ProvidersConfigMetadata;
  builtInModels?: ProviderBuiltInModelMetadata[];
  onChange(p: ModelsProviderDraft): void;
}

/** Models tab for the unified provider editor dialog. */
export function ProviderModelsTab({ provider, metadata, builtInModels, onChange }: ProviderModelsTabProps) {
  const providerRef = useRef(provider ? structuredClone(provider) : undefined);
  const [, rerenderProvider] = useState(0);
  const [newModelId, setNewModelId] = useState("");
  const [selectedModelIndex, setSelectedModelIndex] = useState<number | undefined>(() =>
    provider?.models.length ? 0 : undefined,
  );
  const [selectedBuiltInModelId, setSelectedBuiltInModelId] = useState<string | undefined>(() =>
    provider?.models.length ? undefined : builtInModels?.[0]?.id,
  );
  const [modelPendingDeletion, setModelPendingDeletion] = useState<number>();
  const currentProvider = providerRef.current;
  const customModels = currentProvider?.models ?? [];
  const builtInCount = builtInModels?.length ?? 0;
  const trimmedModelId = newModelId.trim();
  const duplicateModelId = trimmedModelId !== "" && customModels.some((model) => model.config.id === trimmedModelId);
  const selectedModel = selectedModelIndex !== undefined ? customModels[selectedModelIndex] : undefined;
  const selectedBuiltInModel = builtInModels?.find((model) => model.id === selectedBuiltInModelId);
  const pendingDeletionModel = modelPendingDeletion === undefined ? undefined : customModels[modelPendingDeletion];

  useEffect(() => {
    setSelectedModelIndex((current) => {
      if (customModels.length === 0) return undefined;
      if (current === undefined || current >= customModels.length) return 0;
      return current;
    });
  }, [customModels.length]);

  function addModel(): void {
    const id = trimmedModelId;
    if (!id || !currentProvider || duplicateModelId) return;
    const next = [...currentProvider.models, createModelDraft(id)];
    const updated = { ...currentProvider, models: next };
    providerRef.current = updated;
    onChange(updated);
    rerenderProvider((revision) => revision + 1);
    setNewModelId("");
    setSelectedBuiltInModelId(undefined);
    setSelectedModelIndex(next.length - 1);
  }

  function removeModel(index: number): void {
    const current = providerRef.current;
    if (!current) return;
    const next = current.models.filter((_, i) => i !== index);
    const updated = { ...current, models: next };
    providerRef.current = updated;
    onChange(updated);
    rerenderProvider((revision) => revision + 1);
    setSelectedModelIndex((current) => {
      if (next.length === 0) {
        setSelectedBuiltInModelId(builtInModels?.[0]?.id);
        return undefined;
      }
      if (current === undefined) return 0;
      if (index < current) return current - 1;
      if (index === current) return index >= next.length ? next.length - 1 : index;
      return current;
    });
  }

  function updateModel(index: number, updated: ModelsModelDraft): void {
    const current = providerRef.current;
    if (!current) return;
    const next = [...current.models];
    next[index] = updated;
    const nextProvider = { ...current, models: next };
    providerRef.current = nextProvider;
    onChange(nextProvider);
  }

  return (
    <div className="providers-models-workbench">
      {/* Left: built-in + custom model lists */}
      <div className="providers-models-sidebar">
        <div className="providers-models-sidebar-scroll">
          {builtInCount > 0 ? (
            <div className="providers-editor-model-list">
              <p className="providers-model-section-title">
                <strong>内置模型</strong> — {builtInCount} 个
              </p>
              <ul className="providers-editor-builtin-models">
                {builtInModels!.map((model) => (
                  <li key={model.id}>
                    <button
                      type="button"
                      className="providers-builtin-model-select"
                      aria-pressed={model.id === selectedBuiltInModelId}
                      onClick={() => {
                        setSelectedBuiltInModelId(model.id);
                        setSelectedModelIndex(undefined);
                      }}
                    >
                      <span className="providers-model-name">{model.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="providers-editor-model-list">
            <p className="providers-model-section-title">
              <strong>自定义模型</strong>
            </p>
            {currentProvider ? (
              <div className="providers-add-model-row">
                <Input
                  value={newModelId}
                  placeholder="模型 ID，例如 gpt-4.1"
                  aria-describedby={duplicateModelId ? "providers-model-id-error" : undefined}
                  aria-invalid={duplicateModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addModel();
                  }}
                />
                <Button size="sm" variant="outline" disabled={!trimmedModelId || duplicateModelId} onClick={addModel}>
                  <Plus />
                  添加
                </Button>
              </div>
            ) : null}
            {duplicateModelId ? (
              <p className="providers-model-id-error" id="providers-model-id-error" role="alert">
                已存在同名模型 ID。
              </p>
            ) : null}
            {customModels.length > 0 ? (
              <div className="providers-custom-model-list">
                {customModels.map((m, i) => (
                  <div
                    key={`${m.config.id}-${i}`}
                    className={`providers-custom-model-row${i === selectedModelIndex ? " providers-custom-model-row--active" : ""}`}
                  >
                    <button
                      type="button"
                      className="providers-custom-model-select"
                      aria-pressed={i === selectedModelIndex}
                      onClick={() => {
                        setSelectedBuiltInModelId(undefined);
                        setSelectedModelIndex(i);
                      }}
                    >
                      <span className="providers-custom-model-info">
                        <span className="providers-model-name">{m.config.name || m.config.id}</span>
                        {m.config.name && m.config.name !== m.config.id ? (
                          <small className="providers-model-id">{m.config.id}</small>
                        ) : null}
                      </span>
                    </button>
                    <Button
                      className="providers-custom-model-delete text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      size="icon"
                      variant="ghost"
                      aria-label={`删除 ${m.config.id}`}
                      onClick={() => setModelPendingDeletion(i)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="providers-editor-empty">暂无自定义模型。</p>
            )}
          </div>
        </div>
      </div>

      {/* Right: model detail editor */}
      <div className="providers-models-detail">
        {selectedBuiltInModel ? (
          <ProviderBuiltInModelDetail model={selectedBuiltInModel} />
        ) : selectedModel ? (
          <ModelsModelForm
            key={selectedModelIndex}
            model={selectedModel}
            metadata={metadata}
            onChange={(updated) => updateModel(selectedModelIndex!, updated)}
          />
        ) : (
          <div className="providers-models-detail-empty">
            <p>选择内置模型查看配置，或添加自定义模型。</p>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={modelPendingDeletion !== undefined}
        title={`删除 ${pendingDeletionModel?.config.name || pendingDeletionModel?.config.id || "模型"}？`}
        description="该模型的全部本地配置都会被删除。此修改需要保存后才会生效。"
        confirmLabel="删除模型"
        onOpenChange={(open) => {
          if (!open) setModelPendingDeletion(undefined);
        }}
        onConfirm={() => {
          if (modelPendingDeletion !== undefined) removeModel(modelPendingDeletion);
        }}
      />
    </div>
  );
}
