import type { ToolArgumentsContentProps } from "./tool-content-types.ts";
import { parseToolResultRecord, readToolStringArgument } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";

const ACTION_DONE_LABELS: Readonly<Record<string, string>> = {
  add: "已记住",
  replace: "已更新",
  remove: "已移除",
};

export const MEMORY_SCOPE_LABELS: Readonly<Record<string, string>> = {
  memory: "全局记忆",
  user: "用户偏好",
  project: "项目记忆",
  failure: "失败教训",
};

/** 以 diff 风格展示记忆增删改，结果只呈现人话摘要，不落原始 JSON。 */
export function MemoryContent({ args, result, error, expanded }: ToolArgumentsContentProps) {
  const action = readToolStringArgument(args, "action");
  const scopeLabel = MEMORY_SCOPE_LABELS[readToolStringArgument(args, "target")] ?? "记忆";
  const content = readToolStringArgument(args, "content");
  const oldText = readToolStringArgument(args, "old_text");
  const failureReason = readToolStringArgument(args, "failure_reason");
  const record = parseToolResultRecord(result);
  const success = record?.success === true;
  const errorText = typeof record?.error === "string" ? record.error : undefined;
  const warnings = Array.isArray(record?.warnings)
    ? record.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const evicted = Array.isArray(record?.evicted_entries)
    ? record.evicted_entries.filter((item): item is string => typeof item === "string")
    : [];
  const usage = typeof record?.usage === "string" ? record.usage : undefined;

  return (
    <>
      <div className="tool-diff-hunk tool-memory-diff">
        {action !== "add" && oldText ? renderEntryLines(oldText, "remove") : null}
        {action !== "remove" && content ? renderEntryLines(content, "add") : null}
      </div>
      {failureReason ? <div className="tool-note">失败原因：{failureReason}</div> : null}
      {success ? (
        <div className="tool-note" data-tone="success">
          {ACTION_DONE_LABELS[action] ?? "已保存"} · {scopeLabel}
          {usage ? ` · 容量 ${usage}` : ""}
        </div>
      ) : null}
      {warnings.map((warning) => (
        <div className="tool-note" data-tone="warning" key={warning}>
          {warning}
        </div>
      ))}
      {evicted.length > 0 ? (
        <>
          <div className="tool-note" data-tone="warning">
            容量已满，轮换了 {evicted.length} 条旧记忆：
          </div>
          <div className="tool-diff-hunk tool-memory-diff">
            {evicted.map((entry) => renderEntryLines(entry, "remove"))}
          </div>
        </>
      ) : null}
      {errorText ? (
        <div className="tool-note" data-tone="destructive">
          {errorText}
        </div>
      ) : null}
      {result !== undefined && !record ? <ToolResult result={result} error={error} expanded={expanded} /> : null}
    </>
  );
}

function renderEntryLines(text: string, type: "add" | "remove") {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line, index) => (
      <div className={`tool-diff-line tool-diff-line-${type}`} key={`${type}:${index}:${line}`}>
        <span className="tool-diff-sign">{type === "add" ? "+" : "-"}</span>
        <span className="tool-diff-text">{line}</span>
      </div>
    ));
}
