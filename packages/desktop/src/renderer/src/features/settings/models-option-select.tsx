import { Select } from "@renderer/components/assistant-ui/select/select";

interface ModelsOptionSelectProps {
  value: string;
  options: readonly { value: string; label: string }[];
  onValueChange(value: string): void;
}

/** Models-settings select with the shared shadcn/Radix visual contract. */
export function ModelsOptionSelect({ value, options, onValueChange }: ModelsOptionSelectProps) {
  return <Select className="models-select" value={value} options={options} onValueChange={onValueChange} />;
}
