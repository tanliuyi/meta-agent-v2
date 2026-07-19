import { cn } from "@renderer/shared/lib/cn";
import { Command } from "@renderer/shared/ui/command";
import { PopoverContent } from "@renderer/shared/ui/popover-content";
import type { ComponentPropsWithoutRef } from "react";
import { useModelSelectorContext } from "./model-selector-context.ts";
import { ModelSelectorEffort } from "./model-selector-effort.tsx";
import { ModelSelectorFocusAnchor } from "./model-selector-focus-anchor.tsx";
import { ModelSelectorList } from "./model-selector-list.tsx";
import { ModelSelectorSearch } from "./model-selector-search.tsx";

export type ModelSelectorContentProps = ComponentPropsWithoutRef<typeof PopoverContent> & { searchable?: boolean };

export function ModelSelectorContent({
  className,
  align = "start",
  sideOffset = 6,
  searchable,
  children,
  ...props
}: ModelSelectorContentProps) {
  const { value } = useModelSelectorContext();
  const unfiltered = searchable === false || (!searchable && children === undefined);
  return (
    <PopoverContent
      data-slot="model-selector-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "w-64 min-w-(--radix-popover-trigger-width) overflow-hidden rounded-lg bg-popover/95 p-0 shadow-(--elevation-popover) backdrop-blur-sm",
        className,
      )}
      {...props}
    >
      <Command shouldFilter={!unfiltered} {...(value !== undefined ? { defaultValue: value } : {})}>
        {unfiltered ? <ModelSelectorFocusAnchor /> : null}
        {children ?? (
          <>
            {searchable ? <ModelSelectorSearch /> : null}
            <ModelSelectorList />
            <ModelSelectorEffort />
          </>
        )}
      </Command>
    </PopoverContent>
  );
}
