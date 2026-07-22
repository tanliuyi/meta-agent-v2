import type { ToolResultContentProps } from "./tool-content-types.ts";
import { ToolResult } from "./tool-result.tsx";

interface SearchContentProps extends ToolResultContentProps {
  previewLines: number;
}

/** grep 预览 15 行，find/ls 预览 20 行，与 TUI renderer 保持一致。 */
export function SearchContent({ result, error, expanded, previewLines }: SearchContentProps) {
  return <ToolResult result={result} error={error} expanded={expanded} previewLines={previewLines} />;
}
