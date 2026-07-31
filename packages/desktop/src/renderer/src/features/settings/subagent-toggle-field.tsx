import { Switch } from "@renderer/shared/ui/switch";
import { useId } from "react";

interface SubagentToggleFieldProps {
  label: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange(checked: boolean): void;
}

export function SubagentToggleField({ label, checked, defaultChecked, onCheckedChange }: SubagentToggleFieldProps) {
  const controlId = useId();
  return (
    <div className="subagent-toggle-field">
      <label htmlFor={controlId}>{label}</label>
      <Switch id={controlId} checked={checked} defaultChecked={defaultChecked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
