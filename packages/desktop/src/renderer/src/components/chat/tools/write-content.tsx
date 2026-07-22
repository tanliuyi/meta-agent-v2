import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { readToolStringArgument } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

/** TUI write 在调用块中预览内容，成功结果不重复展示。 */
export function WriteContent({ args, result, error, expanded }: ToolArgumentsContentProps) {
  const content = readToolStringArgument(args, "content");
  return (
    <>
      {content ? <ToolCode value={content} expanded={expanded} previewLines={10} /> : null}
      {error ? <ToolResult result={result} error expanded /> : null}
    </>
  );
}
