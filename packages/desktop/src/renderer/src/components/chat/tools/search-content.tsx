import type { ToolResultContentProps } from "./tool-content-types.ts";
import { ToolResult } from "./tool-result.tsx";

/** 渲染 grep、find 与 ls 工具的搜索结果。 */
export function SearchContent({ result, error }: ToolResultContentProps) {
  return <ToolResult result={result} error={error} label="结果" />;
}
