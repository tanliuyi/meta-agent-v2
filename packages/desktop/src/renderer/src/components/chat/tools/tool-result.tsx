import { parseToolResult } from "./tool-format.ts";

interface ToolResultProps {
  result: unknown;
  error: boolean;
  expanded: boolean;
  previewLines?: number;
  previewFromEnd?: boolean;
}

/** 按 TUI 的折叠行数规则渲染 Pi toolResult 文本。 */
export function ToolResult({ result, error, expanded, previewLines = 20, previewFromEnd = false }: ToolResultProps) {
  const parsed = parseToolResult(result);
  if (!parsed) return null;

  const lines = trimTrailingEmptyLines(parsed.text.split("\n"));
  const images = parsed.images ?? [];
  if (lines.length === 0 && images.length === 0) return null;
  const showAll = expanded || lines.length <= previewLines;
  const visibleLines = showAll ? lines : previewFromEnd ? lines.slice(-previewLines) : lines.slice(0, previewLines);
  const hiddenCount = lines.length - visibleLines.length;

  return (
    <div className="tool-output" data-tone={error ? "destructive" : undefined}>
      {hiddenCount > 0 ? (
        <div className="tool-output-truncation">
          {previewFromEnd ? `… 前面省略 ${hiddenCount} 行` : `… 另有 ${hiddenCount} 行`}
        </div>
      ) : null}
      {visibleLines.length > 0 ? <pre className="tool-result">{visibleLines.join("\n")}</pre> : null}
      {images.map((image, index) => (
        <img
          className="tool-result-image"
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={`工具输出图像 ${index + 1}`}
          key={`${image.mimeType}:${index}`}
        />
      ))}
    </div>
  );
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}
