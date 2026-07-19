import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";

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
  if (!value) {
    return (
      <div className="models-optional-editor">
        <span>Thinking level map</span>
        <Button size="sm" variant="outline" onClick={() => onChange({})}>
          <Plus />
          配置映射
        </Button>
      </div>
    );
  }

  return (
    <fieldset className="models-fieldset">
      <legend>Thinking level map</legend>
      <div className="models-thinking-grid">
        {LEVELS.map((level) => {
          const current = value[level];
          const mode = current === undefined ? "inherit" : current === null ? "null" : "value";
          return (
            <div className="models-thinking-row" key={level}>
              <span>{level}</span>
              <Select
                className="models-select"
                value={mode}
                onValueChange={(nextMode) => {
                  const next = structuredClone(value);
                  if (nextMode === "inherit") delete next[level];
                  else if (nextMode === "null") next[level] = null;
                  else next[level] = typeof current === "string" ? current : level;
                  onChange(next);
                }}
                options={[
                  { value: "inherit", label: "未设置" },
                  { value: "null", label: "null" },
                  { value: "value", label: "自定义值" },
                ]}
              />
              <Input
                aria-label={`${level} mapping value`}
                value={typeof current === "string" ? current : ""}
                disabled={mode !== "value"}
                onChange={(event) => onChange({ ...value, [level]: event.target.value })}
              />
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
        清除映射
      </Button>
    </fieldset>
  );
}
