import type { ScmDiff } from "../../../../../shared/scm-contracts.ts";

export interface AlignedDiffRow {
  originalLine?: number;
  modifiedLine?: number;
  originalKind?: "removed";
  modifiedKind?: "added";
}

export function alignedDiffRows(diff: Pick<ScmDiff, "original" | "modified" | "hunks">): AlignedDiffRow[] {
  const originalLength = diff.original?.content.split("\n").length ?? 0;
  const modifiedLength = diff.modified?.content.split("\n").length ?? 0;
  const rows: AlignedDiffRow[] = [];
  let originalLine = 0;
  let modifiedLine = 0;

  const appendContext = (originalEnd: number, modifiedEnd: number) => {
    while (originalLine < originalEnd || modifiedLine < modifiedEnd) {
      rows.push({
        originalLine: originalLine < originalEnd ? originalLine++ : undefined,
        modifiedLine: modifiedLine < modifiedEnd ? modifiedLine++ : undefined,
      });
    }
  };

  for (const hunk of diff.hunks) {
    const originalStart = hunk.originalLines === 0 ? hunk.originalStart : hunk.originalStart - 1;
    const modifiedStart = hunk.modifiedLines === 0 ? hunk.modifiedStart : hunk.modifiedStart - 1;
    appendContext(originalStart, modifiedStart);
    const height = Math.max(hunk.originalLines, hunk.modifiedLines);
    for (let index = 0; index < height; index += 1) {
      rows.push({
        originalLine: index < hunk.originalLines ? originalLine + index : undefined,
        modifiedLine: index < hunk.modifiedLines ? modifiedLine + index : undefined,
        originalKind: index < hunk.originalLines ? "removed" : undefined,
        modifiedKind: index < hunk.modifiedLines ? "added" : undefined,
      });
    }
    originalLine += hunk.originalLines;
    modifiedLine += hunk.modifiedLines;
  }
  appendContext(originalLength, modifiedLength);
  return rows;
}
