import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { ToolResult } from "./tool-result.tsx";

/** TUI bash 折叠态保留最后五个视觉行。 */
export function CommandContent({ result, error, expanded }: ToolArgumentsContentProps) {
  return <ToolResult result={result} error={error} expanded={expanded} previewLines={5} previewFromEnd />;
}
