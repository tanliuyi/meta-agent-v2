import { cva } from "class-variance-authority";

export const settingsMenuItemVariants = cva(
  "flex h-8 w-full items-center gap-[9px] rounded-xl px-[9px] text-(length:--type-size-ui) text-foreground no-underline transition-colors [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)] hover:bg-foreground/[0.055] active:bg-foreground/[0.09] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[hsl(var(--settings-accent)/0.55)] aria-[current=page]:bg-foreground/[0.085] aria-[current=page]:font-medium [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.8] [&_svg]:text-muted-foreground [&_svg]:transition-colors [&_svg]:[transition-duration:var(--motion-duration-fast)] [&_svg]:[transition-timing-function:var(--motion-ease-standard)] hover:[&_svg]:text-foreground aria-[current=page]:[&_svg]:text-foreground",
  {
    variants: {
      variant: {
        default: null,
        back: "mb-(--space-4) text-muted-foreground hover:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
