import type { SubagentModelOption } from "../../../../../shared/subagent-contracts.ts";
import { SubagentFormField } from "./subagent-form-field.tsx";
import { SubagentModelSelect } from "./subagent-model-select.tsx";

const INHERIT_MODEL_VALUE = "";

interface SubagentModelFieldProps {
  initialModel: string;
  models: SubagentModelOption[];
  onValueChange(value: string): void;
}

export function SubagentModelField({ initialModel, models, onValueChange }: SubagentModelFieldProps) {
  return (
    <SubagentFormField label="模型">
      {({ controlId, labelId }) => (
        <SubagentModelSelect
          models={models}
          value={initialModel}
          inheritValue={INHERIT_MODEL_VALUE}
          inheritName="继承当前会话模型"
          controlId={controlId}
          labelId={labelId}
          onValueChange={onValueChange}
        />
      )}
    </SubagentFormField>
  );
}
