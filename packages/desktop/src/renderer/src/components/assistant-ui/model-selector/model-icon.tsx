import { cn } from "@renderer/shared/lib/cn";
import type { ReactNode } from "react";

export function ModelIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5", className)}>
      {children}
    </span>
  );
}
