import { SelectionToolbarPrimitive } from "@assistant-ui/react";
import Quote from "lucide-react/dist/esm/icons/quote.mjs";

/** Quotes a selected assistant response into the active thread composer. */
export function SelectionToolbar() {
  return (
    <SelectionToolbarPrimitive.Root className="flex items-center rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md">
      <SelectionToolbarPrimitive.Quote className="flex h-7 items-center gap-1.5 rounded-xl px-2 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Quote aria-hidden="true" className="size-3.5" />
        引用
      </SelectionToolbarPrimitive.Quote>
    </SelectionToolbarPrimitive.Root>
  );
}
