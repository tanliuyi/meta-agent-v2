interface ToolCodeProps {
  label: string;
  value: string;
  className?: string;
}

/** 渲染带标签的工具参数或代码片段。 */
export function ToolCode({ label, value, className = "tool-code" }: ToolCodeProps) {
  return (
    <section className="tool-section">
      <div className="tool-section-label">{label}</div>
      <pre className={className}>{value || "(空)"}</pre>
    </section>
  );
}
