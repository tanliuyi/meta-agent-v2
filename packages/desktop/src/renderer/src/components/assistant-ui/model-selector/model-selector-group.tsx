import { cn } from "@renderer/shared/lib/cn";
import { CommandGroup } from "@renderer/shared/ui/command-group";
import type { ComponentPropsWithoutRef } from "react";

export type ModelSelectorGroupProps = ComponentPropsWithoutRef<typeof CommandGroup>;

export function ModelSelectorGroup({ className, ...props }: ModelSelectorGroupProps) {
  return (
    <CommandGroup
      data-slot="model-selector-group"
      className={cn(
        "px-1 py-0.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:font-medium",
        className,
      )}
      {...props}
    />
  );
}
