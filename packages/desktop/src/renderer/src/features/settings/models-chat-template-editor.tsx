import type { ModelsChatTemplateKwarg } from "@earendil-works/pi-coding-agent/models-config";
import { Button } from "@renderer/shared/ui/button";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { ModelsCompatDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsOptionSelect } from "./models-option-select.tsx";

interface ModelsChatTemplateEditorProps {
  entries: NonNullable<ModelsCompatDraft["chatTemplateKwargs"]>;
  onChange(entries: NonNullable<ModelsCompatDraft["chatTemplateKwargs"]>): void;
}

/** Structured scalar/variable editor for chat_template_kwargs. */
export function ModelsChatTemplateEditor({ entries, onChange }: ModelsChatTemplateEditorProps) {
  return (
    <fieldset className="models-fieldset models-nested-fieldset">
      <legend>chatTemplateKwargs</legend>
      {entries.map((entry, index) => {
        const kind = chatKwargKind(entry.value);
        return (
          <div className="models-chat-kwarg-row" key={`${entry.origin?.key ?? "new"}-${index}`}>
            <Input
              value={entry.key}
              aria-label={`chatTemplateKwargs key ${index + 1}`}
              onChange={(event) => {
                const next = structuredClone(entries);
                next[index]!.key = event.target.value;
                onChange(next);
              }}
            />
            <ModelsOptionSelect
              value={kind}
              onValueChange={(nextKind) => updateValue(entries, index, defaultChatKwarg(nextKind), onChange)}
              options={[
                { value: "string", label: "string" },
                { value: "number", label: "number" },
                { value: "boolean", label: "boolean" },
                { value: "null", label: "null" },
                { value: "thinking.enabled", label: "thinking.enabled" },
                { value: "thinking.effort", label: "thinking.effort" },
              ]}
            />
            {kind === "boolean" ? (
              <ModelsOptionSelect
                value={String(entry.value)}
                onValueChange={(nextValue) => updateValue(entries, index, nextValue === "true", onChange)}
                options={[
                  { value: "true", label: "true" },
                  { value: "false", label: "false" },
                ]}
              />
            ) : kind === "null" || kind.startsWith("thinking.") ? (
              <label className="models-inline-checkbox">
                <Checkbox
                  disabled={kind === "null"}
                  checked={typeof entry.value === "object" && entry.value !== null && entry.value.omitWhenOff === true}
                  onCheckedChange={(checked) => {
                    if (typeof entry.value !== "object" || entry.value === null) return;
                    updateValue(
                      entries,
                      index,
                      { ...entry.value, omitWhenOff: checked === true || undefined },
                      onChange,
                    );
                  }}
                />
                omitWhenOff
              </label>
            ) : (
              <Input
                type={kind === "number" ? "number" : "text"}
                value={String(entry.value)}
                aria-label={`chatTemplateKwargs value ${index + 1}`}
                onChange={(event) =>
                  updateValue(
                    entries,
                    index,
                    kind === "number" ? Number(event.target.value) : event.target.value,
                    onChange,
                  )
                }
              />
            )}
            <Button
              size="icon"
              variant="ghost"
              title="删除 kwarg"
              aria-label="删除 kwarg"
              onClick={() => onChange(entries.filter((_, entryIndex) => entryIndex !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      <Button size="sm" variant="outline" onClick={() => onChange([...entries, { key: "", value: "" }])}>
        <Plus />
        添加 kwarg
      </Button>
    </fieldset>
  );
}

function chatKwargKind(value: ModelsChatTemplateKwarg): string {
  if (value === null) return "null";
  if (typeof value === "object") return value.$var;
  return typeof value;
}

function defaultChatKwarg(kind: string): ModelsChatTemplateKwarg {
  if (kind === "number") return 0;
  if (kind === "boolean") return false;
  if (kind === "null") return null;
  if (kind === "thinking.enabled" || kind === "thinking.effort") return { $var: kind };
  return "";
}

function updateValue(
  entries: NonNullable<ModelsCompatDraft["chatTemplateKwargs"]>,
  index: number,
  value: ModelsChatTemplateKwarg,
  onChange: ModelsChatTemplateEditorProps["onChange"],
): void {
  const next = structuredClone(entries);
  next[index]!.value = value;
  onChange(next);
}
