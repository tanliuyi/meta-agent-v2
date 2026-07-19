import { cva } from "class-variance-authority";

export const REASONING_ANIMATION_DURATION = 200;

export const reasoningVariants = cva("aui-reasoning-root w-full", {
  variants: {
    variant: {
      outline: "mb-4 rounded-lg border px-3 py-2",
      ghost: "mb-0",
      muted: "mb-4 rounded-lg border bg-muted/50 px-3 py-2",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});
