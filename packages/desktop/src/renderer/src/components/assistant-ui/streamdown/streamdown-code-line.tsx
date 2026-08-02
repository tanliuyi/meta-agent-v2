import type { HighlightResult } from "@streamdown/code";
import { type CSSProperties, memo } from "react";

/** 单行代码。memo 保证流式期间未变化的历史行不会重建 token span。 */
export const CodeLine = memo(function CodeLine({
  line,
  lineIndex,
}: {
  line: HighlightResult["tokens"][number];
  lineIndex: number;
}) {
  return (
    <span className="markdown-code-line">
      <span className="markdown-code-line-number" aria-hidden="true">
        {lineIndex + 1}
      </span>
      <span className="markdown-code-line-text">
        {line.length === 0
          ? " "
          : line.map((token, tokenIndex) => (
              <span
                className="markdown-code-token"
                key={`${tokenIndex}:${token.offset}`}
                style={resolveTokenStyle(token)}
                {...token.htmlAttrs}
              >
                {token.content}
              </span>
            ))}
      </span>
    </span>
  );
});

export function resolveTokenStyle(token: HighlightResult["tokens"][number][number]): CSSProperties {
  const { backgroundColor, color, ...htmlStyle } = token.htmlStyle ?? {};
  const style: Record<string, string | number> = { ...htmlStyle };
  const lightColor = token.color ?? color;
  const lightBackground = token.bgColor ?? backgroundColor;
  if (lightColor) style["--markdown-code-token-color"] = lightColor;
  if (lightBackground) style["--markdown-code-token-background"] = lightBackground;
  return style as CSSProperties;
}
