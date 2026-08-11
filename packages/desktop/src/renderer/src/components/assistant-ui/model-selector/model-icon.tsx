import { cn } from "@renderer/shared/lib/cn";
import type { ReactNode } from "react";

export function ModelIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_img]:object-contain [&_svg]:size-3.5",
        className,
      )}
    >
      {children}
    </span>
  );
}
