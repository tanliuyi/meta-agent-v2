import { cn } from "@renderer/shared/lib/cn";
import { CommandItem } from "@renderer/shared/ui/command-item";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import type { ComponentPropsWithoutRef } from "react";
import { ModelIcon } from "./model-icon.tsx";
import { useModelSelectorContext } from "./model-selector-context.ts";
import type { ModelOption } from "./model-selector-types.ts";

export type ModelSelectorItemProps = Omit<ComponentPropsWithoutRef<typeof CommandItem>, "value"> & {
  model: ModelOption;
};

export function ModelSelectorItem({ model, className, children, onSelect, ...props }: ModelSelectorItemProps) {
  const { value, setValue, setOpen } = useModelSelectorContext();
  const isSelected = value === model.id;
  return (
    <CommandItem
      data-slot="model-selector-item"
      value={model.id}
      keywords={[model.name, ...(model.keywords ?? [])]}
      disabled={model.disabled}
      onSelect={(selectedValue) => {
        setValue(model.id);
        setOpen(false);
        onSelect?.(selectedValue);
      }}
      className={cn(
        "relative mx-1 items-start gap-1.5 rounded-md py-1.5 ps-2 pe-7 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {model.icon ? <ModelIcon>{model.icon}</ModelIcon> : null}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium">{model.name}</span>
            {model.description ? (
              <span className="truncate text-[10px] text-muted-foreground">{model.description}</span>
            ) : null}
          </span>
        </>
      )}
      {isSelected ? (
        <span className="absolute end-2 top-2 flex size-3.5 items-center justify-center">
          <Check className="size-4" aria-hidden="true" />
        </span>
      ) : null}
    </CommandItem>
  );
}
