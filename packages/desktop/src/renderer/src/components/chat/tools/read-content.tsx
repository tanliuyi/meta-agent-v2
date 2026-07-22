import type { ToolResultContentProps } from "./tool-content-types.ts";
import { ToolResult } from "./tool-result.tsx";

/** 与 TUI 一致：成功的 read 默认只显示标题，展开后显示文件内容。 */
export function ReadContent({ result, error, expanded }: ToolResultContentProps) {
  if (!expanded && !error) return null;
  return <ToolResult result={result} error={error} expanded={expanded} previewLines={10} />;
}
