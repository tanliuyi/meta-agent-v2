import type { DiffLine, DiffLineType } from "./tool-format.ts";

const DIFF_SIGN: Record<DiffLineType, string> = { context: " ", remove: "-", add: "+", meta: " " };

export function ToolDiffLines({ lines }: { lines: readonly DiffLine[] }) {
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
