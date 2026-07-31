import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { ToolDiffLines } from "./tool-diff-lines.tsx";
import { diffToolEdit, formatToolValue, parseRenderedToolDiff, parseToolEditArguments } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

/** 完整渲染 Pi/TUI 返回的带文件行号 diff；执行前可从参数生成 diff。 */
export function EditContent({ args, result, error, expanded, argsComplete }: ToolArgumentsContentProps) {
  const renderedDiff = parseRenderedToolDiff(result);
  const edits = argsComplete ? parseToolEditArguments(args) : [];
  const diffGroups = renderedDiff
    ? [renderedDiff]
    : error
      ? []
      : edits.map((edit) => diffToolEdit(edit.oldText, edit.newText));

  return (
    <>
      {diffGroups.map((lines, index) => (
        <div className="tool-diff-hunk" key={`${index}:${lines.length}`}>
          <ToolDiffLines lines={lines} />
        </div>
      ))}
      {argsComplete && !error && diffGroups.length === 0 ? (
        <ToolCode value={formatToolValue(args)} expanded={expanded} />
      ) : null}
      {error ? <ToolResult result={result} error expanded /> : null}
    </>
  );
}
