import type { ReactNode } from "react";

interface SubagentFormFieldProps {
  label: string;
  children: ReactNode;
}

export function SubagentFormField({ label, children }: SubagentFormFieldProps) {
  return (
    <label className="subagent-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
