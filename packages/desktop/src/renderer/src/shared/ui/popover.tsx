import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";

export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}
