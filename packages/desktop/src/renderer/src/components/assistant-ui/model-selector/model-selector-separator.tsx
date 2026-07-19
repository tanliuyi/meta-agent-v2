import { CommandSeparator } from "@renderer/shared/ui/command-separator";
import type { ComponentPropsWithoutRef } from "react";

export type ModelSelectorSeparatorProps = ComponentPropsWithoutRef<typeof CommandSeparator>;

export function ModelSelectorSeparator(props: ModelSelectorSeparatorProps) {
  return <CommandSeparator data-slot="model-selector-separator" {...props} />;
}
