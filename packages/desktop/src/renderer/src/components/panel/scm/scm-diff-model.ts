import type { ScmDiff } from "../../../../../shared/scm-contracts.ts";

export interface AlignedDiffRow {
  originalLine?: number;
  modifiedLine?: number;
  originalKind?: "removed";
  modifiedKind?: "added";
}

export interface PreparedAlignedDiff {
  rows: AlignedDiffRow[];
  originalLines: string[];
  modifiedLines: string[];
  originalWidth: number;
  modifiedWidth: number;
  lineNumberCharacters: number;
}

function alignDiffRows(diff: Pick<ScmDiff, "hunks">, originalLength: number, modifiedLength: number): AlignedDiffRow[] {
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

export function alignedDiffRows(diff: Pick<ScmDiff, "original" | "modified" | "hunks">): AlignedDiffRow[] {
  const originalLength = diff.original?.content.split("\n").length ?? 0;
  const modifiedLength = diff.modified?.content.split("\n").length ?? 0;
  return alignDiffRows(diff, originalLength, modifiedLength);
}

export function prepareAlignedDiff(
  diff: ScmDiff & { original: NonNullable<ScmDiff["original"]>; modified: NonNullable<ScmDiff["modified"]> },
): PreparedAlignedDiff {
  const originalLines = diff.original.content.split("\n");
  const modifiedLines = diff.modified.content.split("\n");
  const width = (lines: readonly string[]) =>
    Math.max(480, lines.reduce((result, line) => Math.max(result, line.length), 0) * 7 + 72);
  return {
    rows: alignDiffRows(diff, originalLines.length, modifiedLines.length),
    originalLines,
    modifiedLines,
    originalWidth: width(originalLines),
    modifiedWidth: width(modifiedLines),
    lineNumberCharacters: Math.max(2, String(Math.max(originalLines.length, modifiedLines.length)).length),
  };
}
