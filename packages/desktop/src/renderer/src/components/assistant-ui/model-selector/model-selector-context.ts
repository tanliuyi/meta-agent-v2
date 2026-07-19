import { createContext, useContext } from "react";
import type { ModelSelectorContextValue, ModelSelectorEffortContextValue } from "./model-selector-types.ts";

export const ModelSelectorContext = createContext<ModelSelectorContextValue | null>(null);
export const ModelSelectorEffortContext = createContext<ModelSelectorEffortContextValue | null>(null);

export function useModelSelectorContext(): ModelSelectorContextValue {
  const context = useContext(ModelSelectorContext);
  if (!context) throw new Error("ModelSelector components must be used within ModelSelectorRoot");
  return context;
}

export function useModelSelectorEfforts(): ModelSelectorEffortContextValue {
  const context = useContext(ModelSelectorEffortContext);
  if (!context) throw new Error("ModelSelector effort components must be used within ModelSelectorRoot");
  return context;
}
