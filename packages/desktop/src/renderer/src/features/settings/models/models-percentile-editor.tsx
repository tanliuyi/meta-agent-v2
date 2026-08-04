import { Input } from "@renderer/shared/ui/input";
import { useRef, useState } from "react";
import { ModelsOptionSelect } from "./models-option-select.tsx";

export type ModelsPercentileValue = number | { p50?: number; p75?: number; p90?: number; p99?: number };

interface ModelsPercentileEditorProps {
  label: string;
  value?: ModelsPercentileValue;
  onChange(value: ModelsPercentileValue | undefined): void;
}

/** Edits routing preferences that accept either one number or percentile cutoffs. */
export function ModelsPercentileEditor({ label, value, onChange }: ModelsPercentileEditorProps) {
  const valueRef = useRef<ModelsPercentileValue | undefined>(value ? structuredClone(value) : value);
  const [draft, setDraft] = useState(valueRef.current);
  const mode = draft === undefined ? "unset" : typeof draft === "number" ? "number" : "percentiles";

  const emit = (next: ModelsPercentileValue | undefined, render = false): void => {
    valueRef.current = next;
    if (render) setDraft(next);
    onChange(next);
  };

  return (
    <div className="models-percentile-row">
      <span>{label}</span>
      <ModelsOptionSelect
        value={mode}
        onValueChange={(nextMode) => {
          if (nextMode === "unset") emit(undefined, true);
          else if (nextMode === "number") emit(0, true);
          else emit({}, true);
        }}
        options={[
          { value: "unset", label: "未设置" },
          { value: "number", label: "数值" },
          { value: "percentiles", label: "Percentiles" },
        ]}
      />
      {typeof draft === "number" ? (
        <Input type="number" defaultValue={draft} onChange={(event) => emit(Number(event.target.value))} />
      ) : draft && typeof draft === "object" ? (
        <div className="models-percentile-inputs">
          {(["p50", "p75", "p90", "p99"] as const).map((field) => (
            <Input
              key={field}
              type="number"
              aria-label={`${label} ${field}`}
              placeholder={field}
              defaultValue={draft[field] ?? ""}
              onChange={(event) => {
                const current = valueRef.current;
                if (!current || typeof current !== "object") return;
                const next = { ...current };
                if (!event.target.value) delete next[field];
                else next[field] = Number(event.target.value);
                emit(next);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
