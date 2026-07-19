import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { readToolStringArgument } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

/** 渲染写入工具的内容与执行结果。 */
export function WriteContent({ args, result, error }: ToolArgumentsContentProps) {
  return (
    <>
      <ToolCode label="写入内容" value={readToolStringArgument(args, "content")} />
      <ToolResult result={result} error={error} />
    </>
  );
}
