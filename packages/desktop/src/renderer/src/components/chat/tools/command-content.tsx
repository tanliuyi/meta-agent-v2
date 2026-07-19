import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { readToolStringArgument } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

/** 渲染 shell 命令及其输出。 */
export function CommandContent({ args, result, error }: ToolArgumentsContentProps) {
  return (
    <>
      <pre className="tool-command">{readToolStringArgument(args, "command")}</pre>
      <ToolResult result={result} error={error} label="输出" />
    </>
  );
}
