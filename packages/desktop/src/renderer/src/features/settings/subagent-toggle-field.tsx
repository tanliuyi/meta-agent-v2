import { Switch } from "@renderer/shared/ui/switch";

interface SubagentToggleFieldProps {
  label: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange(checked: boolean): void;
}

export function SubagentToggleField({ label, checked, defaultChecked, onCheckedChange }: SubagentToggleFieldProps) {
  return (
    <label className="subagent-toggle-field">
      <span>{label}</span>
      <Switch checked={checked} defaultChecked={defaultChecked} onCheckedChange={onCheckedChange} />
    </label>
  );
}
