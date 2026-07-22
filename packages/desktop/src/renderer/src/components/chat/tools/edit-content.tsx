import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import type { DiffLine, DiffLineType } from "./tool-format.ts";
import { diffToolEdit, formatToolValue, parseRenderedToolDiff, parseToolEditArguments } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

const DIFF_SIGN: Record<DiffLineType, string> = { context: " ", remove: "-", add: "+", meta: " " };

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
          {renderDiffLines(lines)}
        </div>
      ))}
      {argsComplete && !error && diffGroups.length === 0 ? (
        <ToolCode value={formatToolValue(args)} expanded={expanded} />
      ) : null}
      {error ? <ToolResult result={result} error expanded /> : null}
    </>
  );
}

function renderDiffLines(lines: DiffLine[]) {
  return lines.length === 0 ? (
    <div className="tool-diff-line tool-diff-line-context">
      <span className="tool-diff-sign"> </span>
      <span className="tool-diff-number" />
      <span className="tool-diff-text">（无变化）</span>
    </div>
  ) : (
    lines.map((line, lineIndex) => (
      <div className={`tool-diff-line tool-diff-line-${line.type}`} key={lineIndex}>
        <span className="tool-diff-sign">{DIFF_SIGN[line.type]}</span>
        <span className="tool-diff-number">{line.lineNumber}</span>
        <span className="tool-diff-text">{line.text}</span>
      </div>
    ))
  );
}
