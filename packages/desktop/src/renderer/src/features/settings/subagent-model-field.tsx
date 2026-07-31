import { SelectContent } from "@renderer/components/assistant-ui/select/select-content";
import { SelectItem } from "@renderer/components/assistant-ui/select/select-item";
import { SelectRoot } from "@renderer/components/assistant-ui/select/select-root";
import { SelectTrigger } from "@renderer/components/assistant-ui/select/select-trigger";
import { SelectValue } from "@renderer/components/assistant-ui/select/select-value";
import { Input } from "@renderer/shared/ui/input";
import { useDeferredValue, useMemo, useState } from "react";
import type { SubagentModelOption } from "../../../../shared/subagent-contracts.ts";
import { SubagentFormField } from "./subagent-form-field.tsx";
import { SubagentModelSelectOptions } from "./subagent-model-select-options.tsx";

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
        {({ controlId, labelId }) => (
          <Input
            id={controlId}
            aria-labelledby={labelId}
            type="search"
            value={search}
            placeholder="输入模型名称或 ID 搜索"
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
      </SubagentFormField>
      <SubagentFormField label="模型">
        {({ controlId, labelId }) => (
          <SelectRoot
            value={model}
            onValueChange={(value) => {
              setModel(value);
              onValueChange(value);
            }}
          >
            <SelectTrigger id={controlId} aria-labelledby={labelId} className="w-full">
              <SelectValue placeholder="继承当前会话模型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">继承当前会话模型</SelectItem>
              <SubagentModelSelectOptions models={filteredModels} />
            </SelectContent>
          </SelectRoot>
        )}
      </SubagentFormField>
    </div>
  );
}
