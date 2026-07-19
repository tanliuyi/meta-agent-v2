import { CommandInput } from "@renderer/shared/ui/command-input";
import type { ComponentPropsWithoutRef } from "react";

export type ModelSelectorSearchProps = ComponentPropsWithoutRef<typeof CommandInput>;

export function ModelSelectorSearch({ placeholder = "搜索模型...", ...props }: ModelSelectorSearchProps) {
  return <CommandInput data-slot="model-selector-search" placeholder={placeholder} {...props} />;
}
