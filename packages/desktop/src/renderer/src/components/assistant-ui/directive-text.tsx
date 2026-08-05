"use client";

import {
  type TextMessagePartComponent,
  type Unstable_DirectiveSegment,
  unstable_defaultDirectiveFormatter,
} from "@assistant-ui/react";
import { memo } from "react";
import { DirectiveIcon } from "./directive-icon.tsx";

const LEGACY_PI_FILE_REFERENCE_RE = /(^|\s)@([^\s@]+)/gu;

export function directiveDisplayLabel(type: string, label: string, id?: string): string {
  if (type !== "file") return label;
  // 会话引用（id 为 session.jsonl 路径）：label 是标题，原样展示（标题可能含路径分隔符）。
  if (id !== undefined && id.endsWith(".jsonl")) return label;
  // 路径引用取 basename；不含分隔符的 label（如模型回复中的文件名）原样展示。
  return label.includes("/") || label.includes("\\") ? (label.split(/[\\/]/u).filter(Boolean).at(-1) ?? label) : label;
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
  if (segments.length === 1 && segments[0]?.kind === "text") {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }

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

        const displayLabel = directiveDisplayLabel(segment.type, segment.label, segment.id);
        return (
          <span
            key={index}
            data-slot="directive-text-chip"
            data-directive-type={segment.type}
            data-directive-id={segment.id}
            aria-label={`${segment.type}: ${displayLabel}`}
            className="aui-directive-chip mx-0.5 inline-flex items-baseline gap-1 rounded-sm bg-primary/10 px-1 py-1 text-(length:--type-size-ui) leading-none text-primary [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:self-center"
          >
            <DirectiveIcon type={segment.type} />
            {displayLabel}
          </span>
        );
      })}
    </>
  );
});
