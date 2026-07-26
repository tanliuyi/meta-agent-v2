import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useRef, useState } from "react";

export interface ModelsCostValue {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: Array<{
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>;
}

interface ModelsCostEditorProps {
  value?: ModelsCostValue;
  requireBaseRates?: boolean;
  onChange(value: ModelsCostValue | undefined): void;
}

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Edits base token rates and ordered high-volume pricing tiers. */
export function ModelsCostEditor({ value, requireBaseRates = false, onChange }: ModelsCostEditorProps) {
  const valueRef = useRef<ModelsCostValue | undefined>(value ? structuredClone(value) : undefined);
  const tierIdsRef = useRef(value?.tiers?.map(() => crypto.randomUUID()) ?? []);
  const [draft, setDraft] = useState(valueRef.current);

  const emit = (next: ModelsCostValue | undefined, render = false): void => {
    valueRef.current = next;
    if (render) setDraft(next);
    onChange(next);
  };

  if (!draft) {
    return (
      <div className="models-optional-editor">
        <span>费用</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => emit(requireBaseRates ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : {}, true)}
        >
          <Plus />
          配置费用
        </Button>
      </div>
    );
  }

  return (
    <fieldset className="models-fieldset">
      <legend>费用（每百万 tokens）</legend>
      <div className="models-rate-grid">
        {RATE_FIELDS.map((field) => (
          <label key={field}>
            <span>{rateLabel(field)}</span>
            <Input
              type="number"
              min="0"
              step="any"
              defaultValue={draft[field] ?? ""}
              required={requireBaseRates}
              onChange={(event) => {
                const next = { ...valueRef.current! };
                const parsed = optionalNumber(event.target.value);
                if (parsed === undefined) delete next[field];
                else next[field] = parsed;
                emit(next);
              }}
            />
          </label>
        ))}
      </div>
      <div className="models-tier-list">
        {draft.tiers?.map((tier, index) => (
          <div className="models-tier-row" key={tierIdsRef.current[index]}>
            <Input
              type="number"
              min="0"
              aria-label={`Tier ${index + 1} token threshold`}
              defaultValue={tier.inputTokensAbove}
              onChange={(event) => {
                const next = structuredClone(valueRef.current!);
                next.tiers![index]!.inputTokensAbove = Number(event.target.value);
                emit(next);
              }}
            />
            {RATE_FIELDS.map((field) => (
              <Input
                key={field}
                type="number"
                min="0"
                step="any"
                aria-label={`Tier ${index + 1} ${rateLabel(field)}`}
                defaultValue={tier[field]}
                onChange={(event) => {
                  const next = structuredClone(valueRef.current!);
                  next.tiers![index]![field] = Number(event.target.value);
                  emit(next);
                }}
              />
            ))}
            <Button
              size="icon"
              variant="ghost"
              title={`删除 Tier ${index + 1}`}
              aria-label={`删除 Tier ${index + 1}`}
              onClick={() => {
                const next = structuredClone(valueRef.current!);
                next.tiers = next.tiers?.filter((_, tierIndex) => tierIndex !== index);
                tierIdsRef.current = tierIdsRef.current.filter((_, tierIndex) => tierIndex !== index);
                if (next.tiers?.length === 0) delete next.tiers;
                emit(next, true);
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <div className="models-inline-actions">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            tierIdsRef.current = [...tierIdsRef.current, crypto.randomUUID()];
            emit(
              {
                ...valueRef.current!,
                tiers: [
                  ...(valueRef.current!.tiers ?? []),
                  { inputTokensAbove: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ],
              },
              true,
            );
          }}
        >
          <Plus />
          添加 Tier
        </Button>
        <Button size="sm" variant="ghost" onClick={() => emit(undefined, true)}>
          清除费用
        </Button>
      </div>
    </fieldset>
  );
}

function optionalNumber(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

function rateLabel(field: (typeof RATE_FIELDS)[number]): string {
  return { input: "输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入" }[field];
}
