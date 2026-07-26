import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useRef, useState } from "react";
import type { ModelsCompatDraft } from "../../../../shared/models-config-contracts.ts";

type VercelRouting = NonNullable<ModelsCompatDraft["config"]["vercelGatewayRouting"]>;

interface ModelsVercelRoutingEditorProps {
  value?: VercelRouting;
  onChange(value?: VercelRouting): void;
}

/** Structured Vercel AI Gateway provider ordering editor. */
export function ModelsVercelRoutingEditor({ value, onChange }: ModelsVercelRoutingEditorProps) {
  const valueRef = useRef<VercelRouting | undefined>(value ? structuredClone(value) : undefined);
  const [draft, setDraft] = useState(valueRef.current);

  const emit = (next: VercelRouting | undefined, render = false): void => {
    valueRef.current = next;
    if (render) setDraft(next);
    onChange(next);
  };

  if (!draft) {
    return (
      <Button size="sm" variant="outline" onClick={() => emit({}, true)}>
        <Plus />
        配置 Vercel routing
      </Button>
    );
  }
  return (
    <fieldset className="models-fieldset models-nested-fieldset">
      <legend>Vercel AI Gateway routing</legend>
      {(["only", "order"] as const).map((field) => (
        <label className="models-field" key={field}>
          <span>{field}</span>
          <Input
            defaultValue={draft[field]?.join(", ") ?? ""}
            onChange={(event) => emit(setStringList(valueRef.current!, field, event.target.value))}
            placeholder="逗号分隔"
          />
        </label>
      ))}
      <Button size="sm" variant="ghost" onClick={() => emit(undefined, true)}>
        清除 Vercel routing
      </Button>
    </fieldset>
  );
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
