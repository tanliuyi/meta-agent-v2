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
        "relative mx-1.5 min-h-8 items-center gap-2 rounded-xl px-2 py-1.5 pe-8 text-[length:var(--type-size-ui)] data-[selected=true]:bg-accent/80 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {model.icon ? <ModelIcon>{model.icon}</ModelIcon> : null}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium">{model.name}</span>
          </span>
        </>
      )}
      {isSelected ? (
        <span className="absolute end-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center text-muted-foreground">
          <Check className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </CommandItem>
  );
}
