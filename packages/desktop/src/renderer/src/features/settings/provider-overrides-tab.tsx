import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useRef, useState } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import type { ProviderBuiltInModelMetadata } from "../../../../shared/providers-config-contracts.ts";
import { ModelsOverrideForm } from "./models-override-form.tsx";
import { createModelOverrideDraft, createProviderDraft } from "./models-settings-model.ts";

interface ProviderOverridesTabProps {
  provider?: ModelsProviderDraft;
  entryKey: string;
  builtInModels?: ProviderBuiltInModelMetadata[];
  onChange(provider: ModelsProviderDraft): void;
}

/** Full editor for per-model overrides in models.json. */
export function ProviderOverridesTab({ provider, entryKey, builtInModels, onChange }: ProviderOverridesTabProps) {
  const providerRef = useRef(provider ? structuredClone(provider) : createProviderDraft(entryKey));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [newOverrideId, setNewOverrideId] = useState("");
  const [pendingDeletion, setPendingDeletion] = useState<number>();
  const actual = providerRef.current;
  const trimmedId = newOverrideId.trim();
  const duplicateId = trimmedId !== "" && actual.modelOverrides.some((override) => override.modelId === trimmedId);
  const selected = actual.modelOverrides[selectedIndex];

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, actual.modelOverrides.length - 1)));
  }, [actual.modelOverrides.length]);

  function addOverride(): void {
    if (!trimmedId || duplicateId) return;
    const modelOverrides = [...providerRef.current.modelOverrides, createModelOverrideDraft(trimmedId)];
    const updated = { ...providerRef.current, modelOverrides };
    providerRef.current = updated;
    onChange(updated);
    setSelectedIndex(modelOverrides.length - 1);
    setNewOverrideId("");
  }

  return (
    <div className="models-entity-form">
      <div className="models-entity-toolbar">
        <Input
          value={newOverrideId}
          placeholder="要覆盖的模型 ID"
          aria-invalid={duplicateId}
          onChange={(event) => setNewOverrideId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addOverride();
          }}
        />
        <Select
          className="models-select models-suggestion-select"
          value={builtInModels?.some((model) => model.id === newOverrideId) ? newOverrideId : "custom"}
          onValueChange={(value) => {
            if (value !== "custom") setNewOverrideId(value);
          }}
          options={[
            { value: "custom", label: "自定义 ID" },
            ...(builtInModels?.map((model) => ({ value: model.id, label: model.name })) ?? []),
          ]}
        />
        <Button size="sm" variant="outline" disabled={!trimmedId || duplicateId} onClick={addOverride}>
          <Plus />
          添加覆盖
        </Button>
      </div>
      {duplicateId ? <p className="providers-model-id-error">已存在同名模型覆盖。</p> : null}

      <div className="models-entity-workbench">
        <div className="models-entity-list" role="listbox" aria-label="模型覆盖">
          {actual.modelOverrides.map((override, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              data-active={index === selectedIndex || undefined}
              key={`${override.origin?.modelId ?? "new"}-${index}`}
              onClick={() => setSelectedIndex(index)}
            >
              <span>{override.config.name || override.modelId}</span>
              <small>{override.modelId}</small>
            </button>
          ))}
        </div>
        <div className="models-entity-detail">
          {selected ? (
            <>
              <div className="models-inline-actions models-entity-delete">
                <Button size="sm" variant="ghost" onClick={() => setPendingDeletion(selectedIndex)}>
                  <Trash2 />
                  删除覆盖
                </Button>
              </div>
              <ModelsOverrideForm
                key={selectedIndex}
                override={selected}
                onChange={(override) => {
                  const modelOverrides = [...providerRef.current.modelOverrides];
                  modelOverrides[selectedIndex] = override;
                  const updated = { ...providerRef.current, modelOverrides };
                  providerRef.current = updated;
                  onChange(updated);
                }}
              />
            </>
          ) : (
            <p className="providers-editor-empty">添加覆盖后在此配置。</p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDeletion !== undefined}
        title={`删除 ${pendingDeletion === undefined ? "模型覆盖" : actual.modelOverrides[pendingDeletion]?.modelId}？`}
        description="该模型覆盖的全部本地配置都会被删除。"
        confirmLabel="删除覆盖"
        onOpenChange={(open) => {
          if (!open) setPendingDeletion(undefined);
        }}
        onConfirm={() => {
          if (pendingDeletion === undefined) return;
          const updated = {
            ...providerRef.current,
            modelOverrides: providerRef.current.modelOverrides.filter((_, index) => index !== pendingDeletion),
          };
          providerRef.current = updated;
          onChange(updated);
          setPendingDeletion(undefined);
        }}
      />
    </div>
  );
}
