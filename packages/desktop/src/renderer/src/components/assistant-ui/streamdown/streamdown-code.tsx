import type { StreamdownTextComponents } from "@assistant-ui/react-streamdown";
import { useIsStreamdownCodeBlock } from "@assistant-ui/react-streamdown";
import { type ComponentPropsWithoutRef, isValidElement, type ReactElement, type ReactNode } from "react";
import { MarkdownCodeBlock } from "./streamdown-code-block.tsx";
import { MarkdownTable } from "./streamdown-table.tsx";

const LANGUAGE_PATTERN = /language-([^\s]+)/;

type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & {
  node?: unknown;
  "data-block"?: string;
};

export const STREAMDOWN_COMPONENTS = {
  code: MarkdownCode,
  table: MarkdownTable,
} satisfies StreamdownTextComponents;

function MarkdownCode({ children, className, node: _node, "data-block": dataBlock, ...props }: MarkdownCodeProps) {
  const inPre = useIsStreamdownCodeBlock();
  if (!inPre && dataBlock === undefined) {
    return (
      <code className="markdown-inline-code" {...props}>
        {children}
      </code>
    );
  }

  const language = className?.match(LANGUAGE_PATTERN)?.[1]?.toLowerCase() ?? "";
  return <MarkdownCodeBlock code={textContent(children).replace(/\n+$/, "")} language={language} />;
}

function textContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isValidElement(value)) return "";
  return textContent((value as ReactElement<{ children?: ReactNode }>).props.children);
}
