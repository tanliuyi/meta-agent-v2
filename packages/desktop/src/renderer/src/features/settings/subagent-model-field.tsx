import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Input } from "@renderer/shared/ui/input";
import { useDeferredValue, useMemo, useState } from "react";
import type { SubagentModelOption } from "../../../../shared/subagent-contracts.ts";
import { SubagentFormField } from "./subagent-form-field.tsx";

interface SubagentModelFieldProps {
  initialModel: string;
  models: SubagentModelOption[];
  onValueChange(value: string): void;
}

export function SubagentModelField({ initialModel, models, onValueChange }: SubagentModelFieldProps) {
  const [search, setSearch] = useState("");
  const [model, setModel] = useState(initialModel);
  const deferredSearch = useDeferredValue(search);
  const filteredModels = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return query ? models.filter((option) => `${option.id} ${option.name}`.toLowerCase().includes(query)) : models;
  }, [deferredSearch, models]);

  return (
    <div className="subagent-form-grid">
      <SubagentFormField label="筛选模型">
        <Input
          type="search"
          value={search}
          placeholder="provider / model"
          onChange={(event) => setSearch(event.target.value)}
        />
      </SubagentFormField>
      <SubagentFormField label="模型">
        <SelectRoot
          value={model}
          onValueChange={(value) => {
            setModel(value);
            onValueChange(value);
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">继承当前会话模型</SelectItem>
            {filteredModels.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name} ({option.id})
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
      </SubagentFormField>
    </div>
  );
}
