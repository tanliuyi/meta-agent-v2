import type { ReactNode } from "react";

export interface ModelSelectorEffortOption {
  id: string;
  name: string;
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  keywords?: readonly string[];
  efforts?: boolean | readonly ModelSelectorEffortOption[];
}

export interface ModelSelectorContextValue {
  models: readonly ModelOption[];
  value: string | undefined;
  setValue(value: string): void;
  selectedModel: ModelOption | undefined;
  setOpen(open: boolean): void;
}

export interface ModelSelectorEffortContextValue {
  efforts: readonly ModelSelectorEffortOption[] | undefined;
  effort: string | undefined;
  setEffort(effort: string): void;
}
