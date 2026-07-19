import { Popover } from "@renderer/shared/ui/popover";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { ModelSelectorContext, ModelSelectorEffortContext } from "./model-selector-context.ts";
import { getModelEfforts, resolveEffort } from "./model-selector-state.ts";
import type { ModelOption } from "./model-selector-types.ts";
import { useControllableState } from "./use-controllable-state.ts";

export interface ModelSelectorRootProps {
  models: readonly ModelOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  effort?: string;
  defaultEffort?: string;
  onEffortChange?(effort: string): void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
}

export function ModelSelectorRoot({
  models,
  value: valueProp,
  defaultValue,
  onValueChange,
  effort: effortProp,
  defaultEffort,
  onEffortChange,
  open: openProp,
  defaultOpen,
  onOpenChange,
  children,
}: ModelSelectorRootProps) {
  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? models[0]?.id,
    onChange: onValueChange,
  });
  const [effort, setEffort] = useControllableState({
    prop: effortProp,
    defaultProp: defaultEffort,
    onChange: onEffortChange,
  });
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });
  const selectedModel = models.find((model) => model.id === value);
  const efforts = getModelEfforts(selectedModel);
  const activeEffort = resolveEffort(efforts, effort);
  const modelContext = useMemo(
    () => ({ models, value, setValue, selectedModel, setOpen }),
    [models, value, setValue, selectedModel, setOpen],
  );
  const effortContext = useMemo(
    () => ({ efforts, effort: activeEffort, setEffort }),
    [efforts, activeEffort, setEffort],
  );

  return (
    <ModelSelectorContext.Provider value={modelContext}>
      <ModelSelectorEffortContext.Provider value={effortContext}>
        <Popover open={open ?? false} onOpenChange={setOpen}>
          {children}
        </Popover>
      </ModelSelectorEffortContext.Provider>
    </ModelSelectorContext.Provider>
  );
}
