import { ToolDiffLines } from "../../tools/tool-diff-lines.tsx";
import type { DiffLine } from "../../tools/tool-format.ts";

export function CheckpointDiff({ patch }: { patch: string }) {
  const lines = parseUnifiedDiff(patch);

  return (
    <div className="checkpoint-diff-scroll" aria-label="diff 代码" role="region" tabIndex={0}>
      <div className="tool-diff-hunk">
        <ToolDiffLines lines={lines} />
      </div>
    </div>
  );
}

export function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const rawLine of patch.replaceAll("\r\n", "\n").split("\n")) {
    if (
      rawLine.startsWith("diff --git ") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ")
    ) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[2] ?? "0", 10);
      continue;
    }
    if (rawLine.startsWith("+")) {
      lines.push({ type: "add", text: rawLine.slice(1), lineNumber: String(newLine) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      lines.push({ type: "remove", text: rawLine.slice(1), lineNumber: String(oldLine) });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      lines.push({ type: "context", text: rawLine.slice(1), lineNumber: String(newLine) });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (rawLine) lines.push({ type: "meta", text: rawLine });
  }
  return lines.length > 0 ? lines : [{ type: "meta", text: "（无可显示的文本变更）" }];
}
