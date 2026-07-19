import { CommandGroup } from "@renderer/shared/ui/command-group";
import type { ComponentPropsWithoutRef } from "react";

export type ModelSelectorGroupProps = ComponentPropsWithoutRef<typeof CommandGroup>;

export function ModelSelectorGroup(props: ModelSelectorGroupProps) {
  return <CommandGroup data-slot="model-selector-group" {...props} />;
}
