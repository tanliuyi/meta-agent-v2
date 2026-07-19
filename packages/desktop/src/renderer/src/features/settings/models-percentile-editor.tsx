import { Input } from "@renderer/shared/ui/input";
import { ModelsOptionSelect } from "./models-option-select.tsx";

export type ModelsPercentileValue = number | { p50?: number; p75?: number; p90?: number; p99?: number };

interface ModelsPercentileEditorProps {
  label: string;
  value?: ModelsPercentileValue;
  onChange(value: ModelsPercentileValue | undefined): void;
}

/** Edits routing preferences that accept either one number or percentile cutoffs. */
export function ModelsPercentileEditor({ label, value, onChange }: ModelsPercentileEditorProps) {
  const mode = value === undefined ? "unset" : typeof value === "number" ? "number" : "percentiles";
  return (
    <div className="models-percentile-row">
      <span>{label}</span>
      <ModelsOptionSelect
        value={mode}
        onValueChange={(nextMode) => {
          if (nextMode === "unset") onChange(undefined);
          else if (nextMode === "number") onChange(0);
          else onChange({});
        }}
        options={[
          { value: "unset", label: "未设置" },
          { value: "number", label: "数值" },
          { value: "percentiles", label: "Percentiles" },
        ]}
      />
      {typeof value === "number" ? (
        <Input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
      ) : value && typeof value === "object" ? (
        <div className="models-percentile-inputs">
          {(["p50", "p75", "p90", "p99"] as const).map((field) => (
            <Input
              key={field}
              type="number"
              aria-label={`${label} ${field}`}
              placeholder={field}
              value={value[field] ?? ""}
              onChange={(event) => {
                const next = { ...value };
                if (!event.target.value) delete next[field];
                else next[field] = Number(event.target.value);
                onChange(next);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
