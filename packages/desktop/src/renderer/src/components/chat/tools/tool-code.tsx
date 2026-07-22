interface ToolCodeProps {
  value: string;
  expanded: boolean;
  previewLines?: number;
}

/** 按 TUI write renderer 的行数规则展示代码参数。 */
export function ToolCode({ value, expanded, previewLines = 10 }: ToolCodeProps) {
  const lines = trimTrailingEmptyLines(value.replace(/\r/g, "").split("\n"));
  const visibleLines = expanded ? lines : lines.slice(0, previewLines);
  const hiddenCount = lines.length - visibleLines.length;

  return (
    <div className="tool-output">
      <pre className="tool-code">{visibleLines.join("\n") || "(空)"}</pre>
      {hiddenCount > 0 ? <div className="tool-output-truncation">… 另有 {hiddenCount} 行</div> : null}
    </div>
  );
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}
