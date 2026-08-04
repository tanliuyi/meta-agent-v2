import type { GitDiffHunk } from "../../../../../shared/git-contracts.ts";

export type ScmDiffLineType = "context" | "remove" | "add" | "meta";

export interface ScmDiffLine {
  key: string;
  type: ScmDiffLineType;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  /** 仅块内首个变更行携带 hunkId，用于渲染块操作。 */
  hunkId?: string;
}

export interface ScmDiffModel {
  lines: ScmDiffLine[];
  lineNumberDigits: number;
  maxColumns: number;
}

/**
 * 解析完整上下文 unified diff。hunk 元数据来自独立的零上下文 patch，
 * 因此完整文件可以连续展示，同时仍保留每个变更块的操作边界。
 */
export function parseScmDiff(patch: string, hunks: readonly GitDiffHunk[]): ScmDiffModel {
  const lines: ScmDiffLine[] = [];
  const actionRows = new Set<string>();
  let oldLine = 0;
  let newLine = 0;
  let sourceIndex = 0;
  let maxLineNumber = 0;
  let maxColumns = 1;

  const append = (line: Omit<ScmDiffLine, "key">) => {
    const hunk = findHunk(line, hunks);
    const hunkId = hunk && !actionRows.has(hunk.id) ? hunk.id : undefined;
    if (hunkId) actionRows.add(hunkId);
    maxLineNumber = Math.max(maxLineNumber, line.oldLineNumber ?? 0, line.newLineNumber ?? 0);
    maxColumns = Math.max(maxColumns, visualColumns(line.text));
    lines.push({ ...line, ...(hunkId ? { hunkId } : {}), key: `${sourceIndex}:${line.type}` });
    sourceIndex += 1;
  };

  for (const rawLine of patch.replaceAll("\r\n", "\n").split("\n")) {
    if (
      rawLine.startsWith("diff --git ") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ")
    ) {
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkHeader) {
      oldLine = Number.parseInt(hunkHeader[1] ?? "0", 10);
      newLine = Number.parseInt(hunkHeader[2] ?? "0", 10);
      continue;
    }
    if (rawLine.startsWith("+")) {
      append({ type: "add", text: rawLine.slice(1), newLineNumber: newLine });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      append({ type: "remove", text: rawLine.slice(1), oldLineNumber: oldLine });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      append({
        type: "context",
        text: rawLine.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (rawLine) append({ type: "meta", text: rawLine });
  }

  if (lines.length === 0) append({ type: "meta", text: "（无可显示的文本变更）" });
  return {
    lines,
    lineNumberDigits: Math.max(2, String(maxLineNumber).length),
    maxColumns,
  };
}

function findHunk(line: Omit<ScmDiffLine, "key">, hunks: readonly GitDiffHunk[]): GitDiffHunk | undefined {
  const newLineNumber = line.newLineNumber;
  if (line.type === "add" && newLineNumber !== undefined) {
    return hunks.find((hunk) => inRange(newLineNumber, hunk.newStart, hunk.newLines));
  }
  const oldLineNumber = line.oldLineNumber;
  if (line.type === "remove" && oldLineNumber !== undefined) {
    return hunks.find((hunk) => inRange(oldLineNumber, hunk.oldStart, hunk.oldLines));
  }
  return undefined;
}

function inRange(line: number, start: number, count: number): boolean {
  return count > 0 && line >= start && line < start + count;
}

/** monospace 横向布局估算；tab-size 与预览 CSS 保持为 4。 */
function visualColumns(value: string): number {
  let columns = 0;
  for (const character of value) columns += character === "\t" ? 4 - (columns % 4) : 1;
  return columns;
}
