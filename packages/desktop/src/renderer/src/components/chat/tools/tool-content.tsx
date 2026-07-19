import { CommandContent } from "./command-content.tsx";
import { EditContent } from "./edit-content.tsx";
import { ReadContent } from "./read-content.tsx";
import { SearchContent } from "./search-content.tsx";
import { ToolCode } from "./tool-code.tsx";
import type { ToolContentProps } from "./tool-content-types.ts";
import { formatToolValue } from "./tool-format.ts";
import { ToolResult } from "./tool-result.tsx";
import { WriteContent } from "./write-content.tsx";

/** 为 Pi 常用工具选择结构化内容，未知工具保留 JSON fallback。 */
export function ToolContent({ name, args, result, error }: ToolContentProps) {
  if (name === "bash") return <CommandContent args={args} result={result} error={error} />;
  if (name === "read") return <ReadContent result={result} error={error} />;
  if (name === "write") return <WriteContent args={args} result={result} error={error} />;
  if (name === "edit") return <EditContent args={args} result={result} error={error} />;
  if (name === "grep" || name === "find" || name === "ls") {
    return <SearchContent result={result} error={error} />;
  }
  return (
    <>
      <ToolCode label="参数" value={formatToolValue(args)} />
      <ToolResult result={result} error={error} />
    </>
  );
}
