import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
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
  { value: "true", label: "true" },
  { value: "false", label: "false" },
] as const;

/** Structured editor for every current OpenRouter routing field. */
export function ModelsOpenRouterEditor({ value, onChange }: ModelsOpenRouterEditorProps) {
  if (!value) {
    return (
      <Button size="sm" variant="outline" onClick={() => onChange({})}>
        <Plus />
        配置 OpenRouter routing
      </Button>
    );
  }
  const booleanFields = ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"] as const;
  const listFields = ["order", "only", "ignore", "quantizations"] as const;
  const sortObject = value.sort && typeof value.sort === "object" ? value.sort : undefined;
  return (
    <fieldset className="models-fieldset models-nested-fieldset">
      <legend>OpenRouter routing</legend>
      <div className="models-compat-grid">
        {booleanFields.map((field) => (
          <label key={field}>
            <span>{field}</span>
            <ModelsOptionSelect
              value={value[field] === undefined ? "unset" : String(value[field])}
              onValueChange={(nextValue) => onChange(setOptionalBoolean(value, field, nextValue))}
              options={TRI_STATE_OPTIONS}
            />
          </label>
        ))}
        <label>
          <span>data_collection</span>
          <ModelsOptionSelect
            value={value.data_collection ?? "unset"}
            onValueChange={(nextValue) =>
              onChange(setOptionalString(value, "data_collection", nextValue === "unset" ? "" : nextValue))
            }
            options={[
              { value: "unset", label: "未设置" },
              { value: "allow", label: "allow" },
              { value: "deny", label: "deny" },
            ]}
          />
        </label>
        {listFields.map((field) => (
          <label key={field}>
            <span>{field}</span>
            <Input
              value={value[field]?.join(", ") ?? ""}
              onChange={(event) => onChange(setStringList(value, field, event.target.value))}
              placeholder="逗号分隔"
            />
          </label>
        ))}
        <div className="models-field">
          <span>sort</span>
          <ModelsOptionSelect
            value={value.sort === undefined ? "unset" : typeof value.sort === "string" ? "string" : "object"}
            onValueChange={(sortMode) => {
              if (sortMode === "unset") onChange({ ...value, sort: undefined });
              else if (sortMode === "string")
                onChange({ ...value, sort: typeof value.sort === "string" ? value.sort : "" });
              else onChange({ ...value, sort: typeof value.sort === "object" ? value.sort : {} });
            }}
            options={[
              { value: "unset", label: "未设置" },
              { value: "string", label: "字符串" },
              { value: "object", label: "对象" },
            ]}
          />
          {typeof value.sort === "string" ? (
            <Input
              value={value.sort}
              onChange={(event) => onChange({ ...value, sort: event.target.value })}
              placeholder="排序名称"
            />
          ) : sortObject ? (
            <div className="models-sort-object">
              <Input
                value={sortObject.by ?? ""}
                onChange={(event) =>
                  onChange({ ...value, sort: { ...sortObject, by: event.target.value || undefined } })
                }
                placeholder="by"
              />
              <ModelsOptionSelect
                value={sortObject.partition === undefined ? "unset" : sortObject.partition === null ? "null" : "value"}
                onValueChange={(partitionMode) => {
                  const sort = { ...sortObject };
                  if (partitionMode === "unset") delete sort.partition;
                  else if (partitionMode === "null") sort.partition = null;
                  else sort.partition = typeof sortObject.partition === "string" ? sortObject.partition : "";
                  onChange({ ...value, sort });
                }}
                options={[
                  { value: "unset", label: "partition 未设置" },
                  { value: "null", label: "partition: null" },
                  { value: "value", label: "partition 值" },
                ]}
              />
              {typeof sortObject.partition === "string" ? (
                <Input
                  value={sortObject.partition}
                  onChange={(event) => onChange({ ...value, sort: { ...sortObject, partition: event.target.value } })}
                  placeholder="partition"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="models-rate-grid">
        {(["prompt", "completion", "image", "audio", "request"] as const).map((field) => (
          <label key={field}>
            <span>max_price.{field}</span>
            <Input
              value={value.max_price?.[field] ?? ""}
              onChange={(event) => {
                const maxPrice = { ...value.max_price };
                if (!event.target.value) delete maxPrice[field];
                else maxPrice[field] = numericOrString(event.target.value);
                onChange({ ...value, max_price: Object.keys(maxPrice).length ? maxPrice : undefined });
              }}
            />
          </label>
        ))}
      </div>
      <ModelsPercentileEditor
        label="preferred_min_throughput"
        value={value.preferred_min_throughput}
        onChange={(next) => onChange({ ...value, preferred_min_throughput: next })}
      />
      <ModelsPercentileEditor
        label="preferred_max_latency"
        value={value.preferred_max_latency}
        onChange={(next) => onChange({ ...value, preferred_max_latency: next })}
      />
      <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
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
