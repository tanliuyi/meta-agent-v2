import { cn } from "@renderer/shared/lib/cn";
import type { ReactNode } from "react";
import { ModelIcon } from "./model-icon.tsx";
import { useModelSelectorContext, useModelSelectorEfforts } from "./model-selector-context.ts";

export interface ModelSelectorValueProps {
  placeholder?: ReactNode;
  showEffort?: boolean;
  className?: string;
}

export function ModelSelectorValue({
  placeholder = "选择模型",
  showEffort = true,
  className,
}: ModelSelectorValueProps) {
  const { selectedModel } = useModelSelectorContext();
  const { efforts, effort } = useModelSelectorEfforts();

  if (!selectedModel) {
    return (
      <span data-slot="model-selector-value" className={cn("text-muted-foreground", className)}>
        {placeholder}
      </span>
    );
  }

  const effortName =
    showEffort && effort !== undefined ? efforts?.find((option) => option.id === effort)?.name : undefined;
  return (
    <span data-slot="model-selector-value" className={cn("flex min-w-0 items-center gap-2", className)}>
      {selectedModel.icon ? <ModelIcon>{selectedModel.icon}</ModelIcon> : null}
      <span className="truncate font-medium">{selectedModel.name}</span>
      {effortName ? <span className="min-w-7.5 truncate text-center text-muted-foreground">{effortName}</span> : null}
    </span>
  );
}
