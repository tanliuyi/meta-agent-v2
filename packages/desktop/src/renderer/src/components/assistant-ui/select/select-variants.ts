import { cva } from "class-variance-authority";

export const selectTriggerVariants = cva(
  "focus-visible:ring-ring/50 data-[placeholder]:text-muted-foreground flex w-fit items-center justify-between gap-2 rounded-md text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&>span]:line-clamp-1",
  {
    variants: {
      variant: {
        outline: "border-input hover:bg-accent hover:text-accent-foreground border bg-transparent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        muted: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
      size: {
        default: "h-(--control-height-select) px-3 py-2",
        sm: "h-(--control-height-button-sm) px-2.5 py-1.5 text-xs",
        lg: "h-(--control-height-button-lg) px-4 py-2.5",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);
