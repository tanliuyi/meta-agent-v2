import { Button } from "@renderer/shared/ui/button";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useRef, useState } from "react";
import type { ModelsChatTemplateKwarg, ModelsCompatDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsOptionSelect } from "./models-option-select.tsx";

interface ModelsChatTemplateEditorProps {
  entries: NonNullable<ModelsCompatDraft["chatTemplateKwargs"]>;
  onChange(entries: NonNullable<ModelsCompatDraft["chatTemplateKwargs"]>): void;
}

type ChatTemplateEntries = NonNullable<ModelsCompatDraft["chatTemplateKwargs"]>;

/** Structured scalar/variable editor for chat_template_kwargs. */
export function ModelsChatTemplateEditor({ entries, onChange }: ModelsChatTemplateEditorProps) {
  const entriesRef = useRef<ChatTemplateEntries>(structuredClone(entries));
  const rowIdsRef = useRef(entries.map(() => crypto.randomUUID()));
  const [rows, setRows] = useState(entriesRef.current);

  const emit = (next: ChatTemplateEntries, render = false): void => {
    entriesRef.current = next;
    if (render) setRows(next);
    onChange(next);
  };

  const updateValue = (index: number, value: ModelsChatTemplateKwarg, render = false): void => {
    const next = structuredClone(entriesRef.current);
    next[index]!.value = value;
    emit(next, render);
  };

  return (
    <fieldset className="models-fieldset models-nested-fieldset">
      <legend>chatTemplateKwargs</legend>
      {rows.map((entry, index) => {
        const kind = chatKwargKind(entry.value);
        return (
          <div className="models-chat-kwarg-row" key={rowIdsRef.current[index]}>
            <Input
              defaultValue={entry.key}
              aria-label={`chatTemplateKwargs key ${index + 1}`}
              onChange={(event) => {
                const next = structuredClone(entriesRef.current);
                next[index]!.key = event.target.value;
                emit(next);
              }}
            />
            <ModelsOptionSelect
              value={kind}
              onValueChange={(nextKind) => updateValue(index, defaultChatKwarg(nextKind), true)}
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
                onValueChange={(nextValue) => updateValue(index, nextValue === "true", true)}
                options={[
                  { value: "true", label: "是 (true)" },
                  { value: "false", label: "否 (false)" },
                ]}
              />
            ) : kind === "null" || kind.startsWith("thinking.") ? (
              <label className="models-inline-checkbox">
                <Checkbox
                  disabled={kind === "null"}
                  defaultChecked={
                    typeof entry.value === "object" && entry.value !== null && entry.value.omitWhenOff === true
                  }
                  onCheckedChange={(checked) => {
                    const current = entriesRef.current[index]?.value;
                    if (typeof current !== "object" || current === null) return;
                    updateValue(index, { ...current, omitWhenOff: checked === true || undefined });
                  }}
                />
                omitWhenOff
              </label>
            ) : (
              <Input
                type={kind === "number" ? "number" : "text"}
                defaultValue={String(entry.value)}
                aria-label={`chatTemplateKwargs value ${index + 1}`}
                onChange={(event) =>
                  updateValue(index, kind === "number" ? Number(event.target.value) : event.target.value)
                }
              />
            )}
            <Button
              size="icon"
              variant="ghost"
              title="删除 kwarg"
              aria-label="删除 kwarg"
              onClick={() => {
                rowIdsRef.current = rowIdsRef.current.filter((_, entryIndex) => entryIndex !== index);
                emit(
                  entriesRef.current.filter((_, entryIndex) => entryIndex !== index),
                  true,
                );
              }}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          rowIdsRef.current = [...rowIdsRef.current, crypto.randomUUID()];
          emit([...entriesRef.current, { key: "", value: "" }], true);
        }}
      >
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
