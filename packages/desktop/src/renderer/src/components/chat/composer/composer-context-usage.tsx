import { cn } from "@renderer/shared/lib/cn";
import type { ContextUsage } from "../../../../../shared/contracts.ts";

interface ComposerContextUsageProps {
  usage: ContextUsage | undefined;
}

const WARN_THRESHOLD = 0.85;
const CIRCUMFERENCE = 2 * Math.PI * 6;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** 上下文窗口使用量环：对话增长时填充，接近限制时红色警告。 */
export function ComposerContextUsage({ usage }: ComposerContextUsageProps) {
  if (!usage) return null;
  const { tokens, contextWindow, percent } = usage;
  const known = tokens !== null && percent !== null;
  const fraction = known ? percent / 100 : 0;
  const warn = known && fraction > WARN_THRESHOLD;
  const percentLabel = known ? `${Math.round(percent)}%` : "?";

  return (
    <div className="group/ctx relative">
      <div
        className={cn(
          "absolute end-0 bottom-full z-(--stack-menu) mb-2 w-60 origin-bottom-right rounded-lg bg-popover p-3 shadow-(--elevation-popover) transition-[opacity,scale] duration-200 motion-reduce:transition-none",
          "pointer-events-none scale-[0.97] opacity-0",
          "group-hover/ctx:pointer-events-auto group-hover/ctx:scale-100 group-hover/ctx:opacity-100",
          "group-focus-within/ctx:pointer-events-auto group-focus-within/ctx:scale-100 group-focus-within/ctx:opacity-100",
        )}
        role="tooltip"
      >
        <div className="flex items-baseline justify-between">
          <p className="text-(length:--type-size-ui) font-medium">上下文使用量</p>
          <p className={cn("font-mono text-xs tabular-nums", warn ? "text-destructive" : "text-muted-foreground")}>
            {percentLabel}
          </p>
        </div>
        <div className="bg-foreground/10 mt-2 flex h-1 w-full overflow-hidden rounded-full">
          <span
            aria-hidden="true"
            className={cn(
              "h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none",
              warn ? "bg-destructive" : "bg-foreground/60",
            )}
            style={{ width: `${Math.min(fraction, 1) * 100}%` }}
          />
        </div>
        <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
          <span>已用</span>
          <span className="font-mono tabular-nums">
            {known ? `${formatTokens(tokens)} / ${formatTokens(contextWindow)}` : "未知"}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label="上下文使用量"
        className={cn(
          "grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          warn && "text-destructive",
        )}
      >
        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" className="stroke-current opacity-20" />
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-current transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={known ? CIRCUMFERENCE * (1 - Math.min(fraction, 1)) : CIRCUMFERENCE}
          />
        </svg>
      </button>
    </div>
  );
}
