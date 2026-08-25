import Check from "lucide-react/dist/esm/icons/check.mjs";
import type { ComponentProps } from "react";
import { cn } from "../../shared/lib/cn.ts";

interface TerminalBlockProps extends Omit<ComponentProps<"section">, "children" | "title"> {
  title: string;
  lines: readonly string[];
  statusLabel?: string;
}

/** Adapted from assistant-ui Elements Terminal Block for completed text output. */
export function TerminalBlock({ title, lines, statusLabel = "已完成", className, ...props }: TerminalBlockProps) {
  return (
    <section
      data-slot="terminal-block"
      className={cn(
        "w-full overflow-hidden rounded-lg border border-border/60 bg-muted/25 font-mono text-xs text-foreground",
        className,
      )}
      {...props}
    >
      <header className="flex min-h-9 items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <span className="min-w-0 truncate font-semibold">{title}</span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <Check className="size-3 text-success" aria-hidden="true" />
          {statusLabel}
        </span>
      </header>
      <div className="max-h-[min(360px,45vh)] overflow-auto px-3 py-2.5 leading-relaxed text-foreground/75">
        {lines.map((line, index) => (
          <div className="min-h-[1lh] whitespace-pre-wrap wrap-break-word" key={`${index}:${line}`}>
            {line || "\u00a0"}
          </div>
        ))}
      </div>
    </section>
  );
}
