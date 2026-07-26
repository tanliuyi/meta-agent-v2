import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useRef, useState } from "react";
import type { ModelsCompatDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsOptionSelect } from "./models-option-select.tsx";
import { ModelsPercentileEditor } from "./models-percentile-editor.tsx";

type OpenRouterRouting = NonNullable<ModelsCompatDraft["config"]["openRouterRouting"]>;

interface ModelsOpenRouterEditorProps {
  value?: OpenRouterRouting;
  onChange(value?: OpenRouterRouting): void;
}

const TRI_STATE_OPTIONS = [
  { value: "unset", label: "未设置" },
  { value: "true", label: "是" },
  { value: "false", label: "否" },
] as const;

const BOOLEAN_FIELDS = ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"] as const;
const LIST_FIELDS = ["order", "only", "ignore", "quantizations"] as const;
const MAX_PRICE_FIELDS = ["prompt", "completion", "image", "audio", "request"] as const;

/** Structured editor for every current OpenRouter routing field. */
export function ModelsOpenRouterEditor({ value, onChange }: ModelsOpenRouterEditorProps) {
  const valueRef = useRef<OpenRouterRouting | undefined>(value ? structuredClone(value) : undefined);
  const [draft, setDraft] = useState(valueRef.current);

  const emit = (next: OpenRouterRouting | undefined, render = false): void => {
    valueRef.current = next;
    if (render) setDraft(next);
    onChange(next);
  };

  if (!draft) {
    return (
      <Button size="sm" variant="outline" onClick={() => emit({}, true)}>
        <Plus />
        配置 OpenRouter routing
      </Button>
    );
  }

  const sortObject = draft.sort && typeof draft.sort === "object" ? draft.sort : undefined;
  return (
    <fieldset className="models-fieldset models-nested-fieldset">
      <legend>OpenRouter routing</legend>
      <div className="models-compat-grid">
        {BOOLEAN_FIELDS.map((field) => (
          <label key={field}>
            <span>{field}</span>
            <ModelsOptionSelect
              value={draft[field] === undefined ? "unset" : String(draft[field])}
              onValueChange={(nextValue) => emit(setOptionalBoolean(valueRef.current!, field, nextValue), true)}
              options={TRI_STATE_OPTIONS}
            />
          </label>
        ))}
        <label>
          <span>data_collection</span>
          <ModelsOptionSelect
            value={draft.data_collection ?? "unset"}
            onValueChange={(nextValue) =>
              emit(
                setOptionalString(valueRef.current!, "data_collection", nextValue === "unset" ? "" : nextValue),
                true,
              )
            }
            options={[
              { value: "unset", label: "未设置" },
              { value: "allow", label: "allow" },
              { value: "deny", label: "deny" },
            ]}
          />
        </label>
        {LIST_FIELDS.map((field) => (
          <label key={field}>
            <span>{field}</span>
            <Input
              defaultValue={draft[field]?.join(", ") ?? ""}
              onChange={(event) => emit(setStringList(valueRef.current!, field, event.target.value))}
              placeholder="逗号分隔"
            />
          </label>
        ))}
        <div className="models-field">
          <span>sort</span>
          <ModelsOptionSelect
            value={draft.sort === undefined ? "unset" : typeof draft.sort === "string" ? "string" : "object"}
            onValueChange={(sortMode) => {
              const current = valueRef.current!;
              if (sortMode === "unset") emit({ ...current, sort: undefined }, true);
              else if (sortMode === "string")
                emit({ ...current, sort: typeof current.sort === "string" ? current.sort : "" }, true);
              else emit({ ...current, sort: typeof current.sort === "object" ? current.sort : {} }, true);
            }}
            options={[
              { value: "unset", label: "未设置" },
              { value: "string", label: "字符串" },
              { value: "object", label: "对象" },
            ]}
          />
          {typeof draft.sort === "string" ? (
            <Input
              defaultValue={draft.sort}
              onChange={(event) => emit({ ...valueRef.current!, sort: event.target.value })}
              placeholder="排序名称"
            />
          ) : sortObject ? (
            <div className="models-sort-object">
              <Input
                defaultValue={sortObject.by ?? ""}
                onChange={(event) => {
                  const currentSort = valueRef.current!.sort;
                  if (!currentSort || typeof currentSort !== "object") return;
                  emit({ ...valueRef.current!, sort: { ...currentSort, by: event.target.value || undefined } });
                }}
                placeholder="by"
              />
              <ModelsOptionSelect
                value={sortObject.partition === undefined ? "unset" : sortObject.partition === null ? "null" : "value"}
                onValueChange={(partitionMode) => {
                  const currentSort = valueRef.current!.sort;
                  if (!currentSort || typeof currentSort !== "object") return;
                  const sort = { ...currentSort };
                  if (partitionMode === "unset") delete sort.partition;
                  else if (partitionMode === "null") sort.partition = null;
                  else sort.partition = typeof currentSort.partition === "string" ? currentSort.partition : "";
                  emit({ ...valueRef.current!, sort }, true);
                }}
                options={[
                  { value: "unset", label: "partition 未设置" },
                  { value: "null", label: "partition: null" },
                  { value: "value", label: "partition 值" },
                ]}
              />
              {typeof sortObject.partition === "string" ? (
                <Input
                  defaultValue={sortObject.partition}
                  onChange={(event) => {
                    const currentSort = valueRef.current!.sort;
                    if (!currentSort || typeof currentSort !== "object") return;
                    emit({ ...valueRef.current!, sort: { ...currentSort, partition: event.target.value } });
                  }}
                  placeholder="partition"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="models-rate-grid">
        {MAX_PRICE_FIELDS.map((field) => (
          <label key={field}>
            <span>max_price.{field}</span>
            <Input
              defaultValue={draft.max_price?.[field] ?? ""}
              onChange={(event) => {
                const current = valueRef.current!;
                const maxPrice = { ...current.max_price };
                if (!event.target.value) delete maxPrice[field];
                else maxPrice[field] = numericOrString(event.target.value);
                emit({ ...current, max_price: Object.keys(maxPrice).length ? maxPrice : undefined });
              }}
            />
          </label>
        ))}
      </div>
      <ModelsPercentileEditor
        label="preferred_min_throughput"
        value={draft.preferred_min_throughput}
        onChange={(next) => emit({ ...valueRef.current!, preferred_min_throughput: next })}
      />
      <ModelsPercentileEditor
        label="preferred_max_latency"
        value={draft.preferred_max_latency}
        onChange={(next) => emit({ ...valueRef.current!, preferred_max_latency: next })}
      />
      <Button size="sm" variant="ghost" onClick={() => emit(undefined, true)}>
        清除 OpenRouter routing
      </Button>
    </fieldset>
  );
}

function setOptionalBoolean<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (input === "unset") delete next[key];
  else next[key] = (input === "true") as T[K];
  return next;
}

function setOptionalString<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  if (!input) delete next[key];
  else next[key] = input as T[K];
  return next;
}

function setStringList<T extends object, K extends keyof T>(value: T, key: K, input: string): T {
  const next = { ...value };
  const list = input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length === 0) delete next[key];
  else next[key] = list as T[K];
  return next;
}

function numericOrString(value: string): number | string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : value;
}
