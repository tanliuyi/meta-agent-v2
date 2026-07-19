import { ToolCode } from "./tool-code.tsx";
import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { formatToolValue, parseToolEdits } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

/** 将编辑工具参数渲染为逐项增删对照。 */
export function EditContent({ args, result, error }: ToolArgumentsContentProps) {
  const edits = parseToolEdits(args.edits);
  return (
    <>
      {edits.map((edit, index) => (
        <section className="tool-edit" key={`${index}:${edit.oldText.length}:${edit.newText.length}`}>
          <div className="tool-section-label">修改 {index + 1}</div>
          <pre className="tool-diff tool-diff-remove">{edit.oldText || "(空)"}</pre>
          <pre className="tool-diff tool-diff-add">{edit.newText || "(删除)"}</pre>
        </section>
      ))}
      {edits.length === 0 ? <ToolCode label="参数" value={formatToolValue(args)} /> : null}
      <ToolResult result={result} error={error} />
    </>
  );
}
