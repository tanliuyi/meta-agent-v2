import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import { DirectiveIcon } from "./directive-icon.tsx";
import { directiveDisplayLabel } from "./directive-text.tsx";

export function ComposerDirectiveChip({ directiveId, directiveType, label }: DirectiveChipProps) {
  const displayLabel = directiveDisplayLabel(directiveType, label);

  return (
    <span className="inline-flex items-baseline px-1">
      <span
        className="aui-directive-chip gap-1"
        data-directive-type={directiveType}
        data-directive-id={directiveId}
        aria-label={displayLabel}
      >
        <DirectiveIcon type={directiveType} />
        <span className="aui-directive-chip-label">{displayLabel}</span>
      </span>
    </span>
  );
}
