import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import type { StructuredWidgetState } from "./structured-widget.tsx";

export function StructuredWidgetStateIndicator({
  state,
  compact = false,
}: {
  state: StructuredWidgetState;
  compact?: boolean;
}) {
  if (state === "running") {
    return (
      <LoaderCircle
        className={`${compact ? "size-3" : "size-4"} shrink-0 animate-spin text-primary`}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      className="composer-structured-widget-glyph"
      data-state={state}
      data-compact={compact || undefined}
      aria-hidden="true"
    >
      {stateGlyph(state)}
    </span>
  );
}

function stateGlyph(state: StructuredWidgetState): string {
  if (state === "queued") return "◦";
  if (state === "success") return "✓";
  if (state === "warning") return "■";
  if (state === "error") return "✗";
  return "○";
}
