import type * as SelectPrimitive from "@radix-ui/react-select";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: ReactNode;
  textValue?: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Pick<ComponentPropsWithoutRef<typeof SelectPrimitive.Root>, "value" | "onValueChange" | "disabled"> {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  className?: string;
}
