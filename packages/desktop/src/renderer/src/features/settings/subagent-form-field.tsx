import { type ReactNode, useId } from "react";

export interface SubagentFormControlIds {
  controlId: string;
  labelId: string;
}

interface SubagentFormFieldProps {
  label: string;
  children(ids: SubagentFormControlIds): ReactNode;
}

export function SubagentFormField({ label, children }: SubagentFormFieldProps) {
  const controlId = useId();
  const labelId = `${controlId}-label`;
  return (
    <div className="subagent-field">
      <label id={labelId} htmlFor={controlId}>
        {label}
      </label>
      {children({ controlId, labelId })}
    </div>
  );
}
