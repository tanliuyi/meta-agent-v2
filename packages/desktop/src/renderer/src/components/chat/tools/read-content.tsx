import type { ToolResultContentProps } from "./tool-content-types.ts";
import { ToolResult } from "./tool-result.tsx";

/** 渲染读取工具返回的文件内容。 */
export function ReadContent({ result, error }: ToolResultContentProps) {
  return <ToolResult result={result} error={error} label="文件内容" />;
}
