import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { readToolStringArgument } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

/** Desktop 展开态展示命令与执行结果，命令预览限制为两个视觉行。 */
export function CommandContent({ args, result, error, expanded }: ToolArgumentsContentProps) {
  const command = readToolStringArgument(args, "command");
  return (
    <>
      {expanded && command ? (
        <pre className="tool-command" title={command}>
          {command}
        </pre>
      ) : null}
      <ToolResult result={result} error={error} expanded={expanded} previewLines={5} previewFromEnd />
    </>
  );
}
