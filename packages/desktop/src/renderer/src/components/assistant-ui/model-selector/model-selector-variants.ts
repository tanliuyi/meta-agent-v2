import { cva } from "class-variance-authority";

export const modelSelectorTriggerVariants = cva(
  "flex w-fit max-w-40 items-center justify-between gap-1.5 overflow-hidden rounded-md text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        muted: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
      size: {
        default: "h-8 px-2.5 py-1.5",
        sm: "h-7 px-2 py-1 text-xs",
        lg: "h-9 px-3 py-2",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);
