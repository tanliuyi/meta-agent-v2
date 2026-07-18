interface ToolContentProps {
  name: string;
  args: Readonly<Record<string, unknown>>;
  result: unknown;
  error: boolean;
}

/** 为 Pi 常用工具选择结构化内容，未知工具保留 JSON fallback。 */
export function ToolContent({ name, args, result, error }: ToolContentProps) {
  if (name === "bash") return <CommandContent args={args} result={result} error={error} />;
  if (name === "read") return <ReadContent args={args} result={result} error={error} />;
  if (name === "write") return <WriteContent args={args} result={result} error={error} />;
  if (name === "edit") return <EditContent args={args} result={result} error={error} />;
  if (name === "grep" || name === "find" || name === "ls") {
    return <SearchContent name={name} args={args} result={result} error={error} />;
  }
  return (
    <>
      <ToolCode label="参数" value={JSON.stringify(args, null, 2)} />
      <ToolResult result={result} error={error} />
    </>
  );
}

function CommandContent({ args, result, error }: Omit<ToolContentProps, "name">) {
  return (
    <>
      <pre className="tool-command">{stringArg(args, "command")}</pre>
      <ToolResult result={result} error={error} label="输出" />
    </>
  );
}

function ReadContent({ args, result, error }: Omit<ToolContentProps, "name">) {
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  const range =
    offset === undefined && limit === undefined
      ? []
      : [`行 ${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : " 起"}`];
  return (
    <>
      <ToolResult result={result} error={error} label="文件内容" />
    </>
  );
}

function WriteContent({ args, result, error }: Omit<ToolContentProps, "name">) {
  return (
    <>
      <ToolCode label="写入内容" value={stringArg(args, "content")} />
      <ToolResult result={result} error={error} />
    </>
  );
}

function EditContent({ args, result, error }: Omit<ToolContentProps, "name">) {
  const edits = Array.isArray(args.edits) ? args.edits.flatMap(toEdit) : [];
  return (
    <>
      {edits.map((edit, index) => (
        <section className="tool-edit" key={`${index}:${edit.oldText.length}:${edit.newText.length}`}>
          <div className="tool-section-label">修改 {index + 1}</div>
          <pre className="tool-diff tool-diff-remove">{edit.oldText || "(空)"}</pre>
          <pre className="tool-diff tool-diff-add">{edit.newText || "(删除)"}</pre>
        </section>
      ))}
      {edits.length === 0 ? <ToolCode label="参数" value={JSON.stringify(args, null, 2)} /> : null}
      <ToolResult result={result} error={error} />
    </>
  );
}

function SearchContent({ name, args, result, error }: ToolContentProps) {
  const items = [
    name === "ls" ? stringArg(args, "path") || "." : stringArg(args, "pattern"),
    name === "ls" ? "" : stringArg(args, "path") || ".",
    stringArg(args, "glob"),
  ].filter(Boolean);
  return (
    <>
      <ToolResult result={result} error={error} label="结果" />
    </>
  );
}

function ToolCode({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <section className="tool-section">
      <div className="tool-section-label">{label}</div>
      <pre className={className}>{value || "(空)"}</pre>
    </section>
  );
}

function ToolResult({ result, error, label = "结果" }: { result: unknown; error: boolean; label?: string }) {
  if (result === undefined) return null;
  return (
    <section className="tool-section">
      <div className="tool-section-label">{label}</div>
      <pre className={error ? "tool-result error" : "tool-result"}>{formatResult(result) || "(无输出)"}</pre>
    </section>
  );
}

function stringArg(args: Readonly<Record<string, unknown>>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return value;
  }
  return "";
}

function numberArg(args: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

function toEdit(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!value || typeof value !== "object") return [];
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === "string" && typeof edit.newText === "string"
    ? [{ oldText: edit.oldText, newText: edit.newText }]
    : [];
}

function formatResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
