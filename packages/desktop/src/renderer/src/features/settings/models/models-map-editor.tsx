import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useRef, useState } from "react";
import type { ModelsMapEntryDraft } from "../../../../../shared/models-config-contracts.ts";

interface ModelsMapEditorProps {
  label: string;
  entries: ModelsMapEntryDraft<string>[];
  onChange(entries: ModelsMapEntryDraft<string>[]): void;
}

interface ModelsMapEditorRow {
  id: string;
  entry: ModelsMapEntryDraft<string>;
}

/** Structured key/value editor that retains each entry's origin across renames. */
export function ModelsMapEditor({ label, entries, onChange }: ModelsMapEditorProps) {
  const [rows, setRows] = useState<ModelsMapEditorRow[]>(() =>
    structuredClone(entries).map((entry) => ({ id: crypto.randomUUID(), entry })),
  );
  const rowsRef = useRef(rows);

  const emit = (next: ModelsMapEditorRow[], render: boolean): void => {
    rowsRef.current = next;
    if (render) setRows(next);
    onChange(next.map((row) => row.entry));
  };

  return (
    <fieldset className="models-fieldset">
      <legend>{label}</legend>
      <div className="models-map-rows">
        {rows.map((row, index) => (
          <div className="models-map-row" key={row.id}>
            <Input
              aria-label={`${label} key ${index + 1}`}
              defaultValue={row.entry.key}
              placeholder="Header name"
              onChange={(event) => {
                const next = [...rowsRef.current];
                const current = next[index]!;
                next[index] = { ...current, entry: { ...current.entry, key: event.target.value } };
                emit(next, false);
              }}
            />
            <Input
              aria-label={`${label} value ${index + 1}`}
              defaultValue={row.entry.value}
              placeholder="Value, $ENV or !command"
              onChange={(event) => {
                const next = [...rowsRef.current];
                const current = next[index]!;
                next[index] = { ...current, entry: { ...current.entry, value: event.target.value } };
                emit(next, false);
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              title={`删除 ${row.entry.key || "空 key"}`}
              aria-label={`删除 ${row.entry.key || "空 key"}`}
              onClick={() =>
                emit(
                  rowsRef.current.filter((_, entryIndex) => entryIndex !== index),
                  true,
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => emit([...rowsRef.current, { id: crypto.randomUUID(), entry: { key: "", value: "" } }], true)}
      >
        <Plus />
        添加条目
      </Button>
    </fieldset>
  );
}
