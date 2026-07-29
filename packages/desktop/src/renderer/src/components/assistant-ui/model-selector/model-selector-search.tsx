import { cn } from "@renderer/shared/lib/cn";
import { CommandInput } from "@renderer/shared/ui/command-input";
import type { ComponentPropsWithoutRef } from "react";

export type ModelSelectorSearchProps = ComponentPropsWithoutRef<typeof CommandInput>;

export function ModelSelectorSearch({ className, placeholder = "搜索模型...", ...props }: ModelSelectorSearchProps) {
  return (
    <CommandInput
      data-slot="model-selector-search"
      className={cn("h-9 text-[length:var(--type-size-ui)]", className)}
      placeholder={placeholder}
      {...props}
    />
  );
}
