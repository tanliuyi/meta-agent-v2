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
        "z-(--stack-menu) flex max-h-(--radix-popover-content-available-height) w-72 max-w-[calc(100vw-1rem)] min-w-(--radix-popover-trigger-width) flex-col overflow-hidden rounded-lg bg-popover p-0 shadow-(--elevation-popover) [&_[data-slot=command-input-wrapper]]:h-9 [&_[data-slot=command-input-wrapper]]:gap-2.5 [&_[data-slot=command-input-wrapper]]:border-border/70 [&_[data-slot=command-input-wrapper]]:px-3 [&_[data-slot=command-input-wrapper]_svg]:size-4",
        className,
      )}
      {...props}
    >
      <Command className="min-h-0" shouldFilter={!unfiltered} {...(value !== undefined ? { defaultValue: value } : {})}>
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
