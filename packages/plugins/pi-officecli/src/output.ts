import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

/**
 * Truncate tool output to pi's normal 50 KB / 2,000-line boundary and tell the
 * model how to recover the full content (narrower path, smaller depth, or a
 * render).
 */
export function truncateToolOutput(text: string): string {
  const result = truncateHead(text);
  if (!result.truncated) return text;
  const reason = result.truncatedBy === "lines" ? "行数" : "字节数";
  return (
    `${result.content}\n\n` +
    `[输出已截断（${reason}上限）: 原文 ${result.totalLines} 行 / ${formatSize(result.totalBytes)}，` +
    `仅显示前 ${result.outputLines} 行 / ${formatSize(result.outputBytes)}。` +
    `如需完整内容，请缩小读取范围（更深的路径、更小的 depth、更少的列），或改用 office_render 渲染。]`
  );
}
