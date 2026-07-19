import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@renderer/shared/lib/cn";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useModelSelectorEfforts } from "./model-selector-context.ts";

export type ModelSelectorEffortProps = ComponentPropsWithoutRef<"div"> & {
  label?: ReactNode;
};

export function ModelSelectorEffort({ label = "Thinking", className, onKeyDown, ...props }: ModelSelectorEffortProps) {
  const { efforts, effort, setEffort } = useModelSelectorEfforts();
  if (!efforts?.length) return null;

  return (
    <div
      data-slot="model-selector-effort"
      className={cn("flex items-center justify-between gap-3 border-t px-3 py-2", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Home" || event.key === "End") event.stopPropagation();
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.currentTarget.closest("[cmdk-root]")?.querySelector<HTMLInputElement>("[cmdk-input]")?.focus();
        }
      }}
      {...props}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <RadioGroupPrimitive.Root
        value={effort ?? ""}
        onValueChange={setEffort}
        orientation="horizontal"
        aria-label={typeof label === "string" ? label : "Reasoning effort"}
        className="flex items-center gap-0.5"
      >
        {efforts.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.id}
            value={option.id}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:bg-accent data-[state=checked]:font-medium data-[state=checked]:text-accent-foreground"
          >
            {option.name}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}
