"use client";

import {
  type TextMessagePartComponent,
  type Unstable_DirectiveSegment,
  unstable_defaultDirectiveFormatter,
} from "@assistant-ui/react";
import { memo } from "react";

const LEGACY_PI_FILE_REFERENCE_RE = /(^|\s)@([^\s@]+)/gu;

export function directiveDisplayLabel(type: string, label: string): string {
  if (type !== "file") return label;
  return label.split(/[\\/]/u).filter(Boolean).at(-1) ?? label;
}

function parseLegacyPiFileReferences(text: string): Unstable_DirectiveSegment[] {
  const segments: Unstable_DirectiveSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(LEGACY_PI_FILE_REFERENCE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ kind: "text", text: text.slice(lastIndex, index) });
    if (match[1]) segments.push({ kind: "text", text: match[1] });
    const path = match[2]!;
    segments.push({ kind: "mention", type: "file", label: path, id: path });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) segments.push({ kind: "text", text: text.slice(lastIndex) });
  return segments.length === 0 ? [{ kind: "text", text }] : segments;
}

function parseDirectiveText(text: string): Unstable_DirectiveSegment[] {
  return unstable_defaultDirectiveFormatter
    .parse(text)
    .flatMap((segment) => (segment.kind === "text" ? parseLegacyPiFileReferences(segment.text) : [segment]));
}

/** Renders assistant-ui directives and legacy Pi composer file references as inline chips. */
export const DirectiveText: TextMessagePartComponent = memo(function DirectiveText({ text }) {
  const segments = parseDirectiveText(text);
  if (segments.length === 1 && segments[0]?.kind === "text") return <>{text}</>;

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return (
            <span key={index} className="whitespace-pre-wrap">
              {segment.text}
            </span>
          );
        }

        const displayLabel = directiveDisplayLabel(segment.type, segment.label);
        return (
          <span
            key={index}
            data-slot="directive-text-chip"
            data-directive-type={segment.type}
            data-directive-id={segment.id}
            aria-label={`${segment.type}: ${displayLabel}`}
            className="aui-directive-chip mx-0.5 inline-flex items-baseline gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-(length:--type-size-ui) leading-none text-primary [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:self-center"
          >
            {displayLabel}
          </span>
        );
      })}
    </>
  );
});
