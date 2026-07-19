import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { ModelsMapEntryDraft } from "../../../../shared/models-config-contracts.ts";

interface ModelsMapEditorProps {
  label: string;
  entries: ModelsMapEntryDraft<string>[];
  onChange(entries: ModelsMapEntryDraft<string>[]): void;
}

/** Structured key/value editor that retains each entry's origin across renames. */
export function ModelsMapEditor({ label, entries, onChange }: ModelsMapEditorProps) {
  return (
    <fieldset className="models-fieldset">
      <legend>{label}</legend>
      <div className="models-map-rows">
        {entries.map((entry, index) => (
          <div className="models-map-row" key={`${entry.origin?.key ?? "new"}-${index}`}>
            <Input
              aria-label={`${label} key ${index + 1}`}
              value={entry.key}
              placeholder="Header name"
              onChange={(event) => {
                const next = structuredClone(entries);
                next[index]!.key = event.target.value;
                onChange(next);
              }}
            />
            <Input
              aria-label={`${label} value ${index + 1}`}
              value={entry.value}
              placeholder="Value, $ENV or !command"
              onChange={(event) => {
                const next = structuredClone(entries);
                next[index]!.value = event.target.value;
                onChange(next);
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              title={`删除 ${entry.key || "空 key"}`}
              aria-label={`删除 ${entry.key || "空 key"}`}
              onClick={() => onChange(entries.filter((_, entryIndex) => entryIndex !== index))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={() => onChange([...entries, { key: "", value: "" }])}>
        <Plus />
        添加条目
      </Button>
    </fieldset>
  );
}
