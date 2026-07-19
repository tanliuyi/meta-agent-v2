import { cn } from "@renderer/shared/lib/cn";
import { CommandGroup } from "@renderer/shared/ui/command-group";
import { CommandList } from "@renderer/shared/ui/command-list";
import type { ComponentPropsWithoutRef } from "react";
import { useModelSelectorContext } from "./model-selector-context.ts";
import { ModelSelectorEmpty } from "./model-selector-empty.tsx";
import { ModelSelectorItem } from "./model-selector-item.tsx";

export type ModelSelectorListProps = ComponentPropsWithoutRef<typeof CommandList>;

export function ModelSelectorList({ className, children, ...props }: ModelSelectorListProps) {
  const { models } = useModelSelectorContext();
  return (
    <CommandList
      data-slot="model-selector-list"
      className={cn(
        "max-h-64 py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <ModelSelectorEmpty />
          <CommandGroup>
            {models.map((model) => (
              <ModelSelectorItem key={model.id} model={model} />
            ))}
          </CommandGroup>
        </>
      )}
    </CommandList>
  );
}
