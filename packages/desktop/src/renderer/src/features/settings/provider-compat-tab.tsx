import { useRef } from "react";
import type { ModelsProviderDraft } from "../../../../shared/models-config-contracts.ts";
import { ModelsCompatEditor } from "./models-compat-editor.tsx";
import { createProviderDraft } from "./models-settings-model.ts";

interface ProviderCompatTabProps {
  provider?: ModelsProviderDraft;
  entryKey: string;
  onChange(provider: ModelsProviderDraft): void;
}

export function ProviderCompatTab({ provider, entryKey, onChange }: ProviderCompatTabProps) {
  const draftRef = useRef<ModelsProviderDraft>(provider ? structuredClone(provider) : createProviderDraft(entryKey));

  return (
    <ModelsCompatEditor
      value={draftRef.current.compat}
      onChange={(compat) => {
        const next = { ...draftRef.current, compat };
        draftRef.current = next;
        onChange(next);
      }}
    />
  );
}
