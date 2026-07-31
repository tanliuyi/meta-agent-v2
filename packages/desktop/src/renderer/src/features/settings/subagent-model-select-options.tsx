import { SelectGroup } from "@renderer/components/assistant-ui/select/select-group";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectLabel } from "@renderer/components/assistant-ui/select/select-label";
import { useMemo } from "react";
import type { SubagentModelOption } from "../../../../shared/subagent-contracts.ts";
import { groupSubagentModels } from "./subagent-model-options.ts";

interface SubagentModelSelectOptionsProps {
  models: readonly SubagentModelOption[];
}

export function SubagentModelSelectOptions({ models }: SubagentModelSelectOptionsProps) {
  const groups = useMemo(() => groupSubagentModels(models), [models]);
  return [...groups].map(([provider, providerModels]) => (
    <SelectGroup key={provider}>
      <SelectLabel>{provider}</SelectLabel>
      {providerModels.map((model) => (
        <SelectItem key={model.id} value={model.id}>
          {model.name} ({model.id})
        </SelectItem>
      ))}
    </SelectGroup>
  ));
}
