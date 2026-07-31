import { Combobox } from "@renderer/shared/ui/combobox";
import { useMemo, useState } from "react";
import type { SubagentSkillOption } from "../../../../shared/subagent-contracts.ts";
import { SubagentFormField } from "./subagent-form-field.tsx";

interface SubagentSkillsFieldProps {
  initialValue: string;
  skills: SubagentSkillOption[];
  label?: string;
  placeholder?: string;
  onValueChange(value: string): void;
}

export function SubagentSkillsField({
  initialValue,
  skills,
  label = "技能",
  placeholder = "输入或选择技能，多个技能用英文逗号分隔",
  onValueChange,
}: SubagentSkillsFieldProps) {
  const [value, setValue] = useState(initialValue);
  const options = useMemo(() => skills.map((skill) => ({ value: skill.name, label: skill.name })), [skills]);

  return (
    <SubagentFormField label={label}>
      {({ controlId, labelId }) => (
        <Combobox
          inputId={controlId}
          ariaLabelledBy={labelId}
          value={value}
          options={options}
          placeholder={placeholder}
          emptyText="无匹配技能"
          onValueChange={(next) => {
            setValue(next);
            onValueChange(next);
          }}
        />
      )}
    </SubagentFormField>
  );
}
