import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import type { DiffLineType } from "./tool-format.ts";
import { diffToolEdit, formatToolValue, parseToolEditArguments } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

const DIFF_SIGN: Record<DiffLineType, string> = { context: " ", remove: "-", add: "+", meta: "\\" };

/** 将编辑工具参数渲染为 GitHub 风格的统一行 diff，失败时保留具体结果。 */
export function EditContent({ args, result, error }: ToolArgumentsContentProps) {
  const edits = parseToolEditArguments(args);
  return (
    <>
      {edits.map((edit, index) => {
        const lines = diffToolEdit(edit.oldText, edit.newText);
        return (
          <section className="tool-edit" key={`${index}:${edit.oldText.length}:${edit.newText.length}`}>
            <div className="tool-section-label">修改 {index + 1}</div>
            <div className="tool-diff-hunk">
              {lines.length === 0 ? (
                <div className="tool-diff-line tool-diff-line-context">
                  <span className="tool-diff-sign"> </span>
                  <span className="tool-diff-text">（无变化）</span>
                </div>
              ) : (
                lines.map((line, lineIndex) => (
                  <div className={`tool-diff-line tool-diff-line-${line.type}`} key={lineIndex}>
                    <span className="tool-diff-sign">{DIFF_SIGN[line.type]}</span>
                    <span className="tool-diff-text">{line.text}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        );
      })}
      {edits.length === 0 ? <ToolCode label="参数" value={formatToolValue(args)} /> : null}
      {error ? <ToolResult result={result} error label="错误" /> : null}
    </>
  );
}
