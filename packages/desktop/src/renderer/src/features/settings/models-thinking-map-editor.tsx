import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useRef, useState } from "react";

export interface ModelsThinkingMapValue {
  off?: string | null;
  minimal?: string | null;
  low?: string | null;
  medium?: string | null;
  high?: string | null;
  xhigh?: string | null;
  max?: string | null;
}

interface ModelsThinkingMapEditorProps {
  value?: ModelsThinkingMapValue;
  onChange(value: ModelsThinkingMapValue | undefined): void;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Maps Pi thinking levels to provider values, including explicit null. */
export function ModelsThinkingMapEditor({ value, onChange }: ModelsThinkingMapEditorProps) {
  const valueRef = useRef<ModelsThinkingMapValue | undefined>(value ? structuredClone(value) : undefined);
  const [draft, setDraft] = useState(valueRef.current);

  const emit = (next: ModelsThinkingMapValue | undefined, render = false): void => {
    valueRef.current = next;
    if (render) setDraft(next);
    onChange(next);
  };

  if (!draft) {
    return (
      <div className="models-optional-editor">
        <span>思考等级映射</span>
        <Button size="sm" variant="outline" onClick={() => emit({}, true)}>
          <Plus />
          配置映射
        </Button>
      </div>
    );
  }

  return (
    <fieldset className="models-fieldset">
      <legend>思考等级映射</legend>
      <div className="models-thinking-grid">
        {LEVELS.map((level) => {
          const current = draft[level];
          const mode = current === undefined ? "inherit" : current === null ? "null" : "value";
          return (
            <div className="models-thinking-row" key={level}>
              <span>{level}</span>
              <Select
                className="models-select"
                value={mode}
                onValueChange={(nextMode) => {
                  const next = { ...valueRef.current! };
                  const currentValue = next[level];
                  if (nextMode === "inherit") delete next[level];
                  else if (nextMode === "null") next[level] = null;
                  else next[level] = typeof currentValue === "string" ? currentValue : level;
                  emit(next, true);
                }}
                options={[
                  { value: "inherit", label: "未设置" },
                  { value: "null", label: "null" },
                  { value: "value", label: "自定义值" },
                ]}
              />
              <Input
                key={`${level}:${mode}`}
                aria-label={`${level} mapping value`}
                defaultValue={typeof current === "string" ? current : ""}
                disabled={mode !== "value"}
                onChange={(event) => emit({ ...valueRef.current!, [level]: event.target.value })}
              />
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" onClick={() => emit(undefined, true)}>
        清除映射
      </Button>
    </fieldset>
  );
}
