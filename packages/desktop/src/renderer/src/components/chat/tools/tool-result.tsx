import { formatToolValue } from "./tool-format.ts";

interface ToolResultProps {
  result: unknown;
  error: boolean;
  label?: string;
}

/** 渲染工具结果，并为失败结果附加错误样式状态。 */
export function ToolResult({ result, error, label = "结果" }: ToolResultProps) {
  if (result === undefined) return null;
  return (
    <section className="tool-section">
      <div className="tool-section-label">{label}</div>
      <pre className="tool-result" data-tone={error ? "destructive" : undefined}>
        {formatToolValue(result) || "(无输出)"}
      </pre>
    </section>
  );
}
