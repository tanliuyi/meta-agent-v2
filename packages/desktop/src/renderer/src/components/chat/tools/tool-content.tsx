import { CommandContent } from "./command-content.tsx";
import { EditContent } from "./edit-content.tsx";
import { ReadContent } from "./read-content.tsx";
import { SearchContent } from "./search-content.tsx";
import { ToolCode } from "./tool-code.tsx";
import type { ToolContentProps } from "./tool-content-types.ts";
import { formatToolValue } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";
import { WriteContent } from "./write-content.tsx";

/** 为 Pi 常用工具复刻 TUI 的标题/预览信息密度，未知工具保留 JSON fallback。 */
export function ToolContent({ name, args, result, error, expanded, argsComplete }: ToolContentProps) {
  if (name === "bash") {
    return <CommandContent args={args} result={result} error={error} expanded={expanded} argsComplete={argsComplete} />;
  }
  if (name === "read") return <ReadContent result={result} error={error} expanded={expanded} />;
  if (name === "write") {
    return <WriteContent args={args} result={result} error={error} expanded={expanded} argsComplete={argsComplete} />;
  }
  if (name === "edit") {
    return <EditContent args={args} result={result} error={error} expanded={expanded} argsComplete={argsComplete} />;
  }
  if (name === "grep" || name === "find" || name === "ls") {
    return <SearchContent result={result} error={error} expanded={expanded} previewLines={name === "grep" ? 15 : 20} />;
  }
  return (
    <>
      <ToolCode value={formatToolValue(args)} expanded={expanded} />
      <ToolResult result={result} error={error} expanded={expanded} />
    </>
  );
}
