import type { ComponentProps } from "react";
import { cn } from "@/lib/utils.ts";

function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("flex flex-col rounded-lg border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}

export { Card, CardContent };
