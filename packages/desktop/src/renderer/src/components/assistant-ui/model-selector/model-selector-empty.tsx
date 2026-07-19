import { CommandEmpty } from "@renderer/shared/ui/command-empty";
import type { ComponentPropsWithoutRef } from "react";

export type ModelSelectorEmptyProps = ComponentPropsWithoutRef<typeof CommandEmpty>;

export function ModelSelectorEmpty({ children, ...props }: ModelSelectorEmptyProps) {
  return (
    <CommandEmpty data-slot="model-selector-empty" {...props}>
      {children ?? "未找到模型"}
    </CommandEmpty>
  );
}
