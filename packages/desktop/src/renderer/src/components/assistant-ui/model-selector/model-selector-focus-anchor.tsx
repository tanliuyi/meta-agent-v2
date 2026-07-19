import { CommandInput } from "@renderer/shared/ui/command-input";

export function ModelSelectorFocusAnchor() {
  return (
    <div className="sr-only">
      <CommandInput readOnly aria-label="模型" />
    </div>
  );
}
