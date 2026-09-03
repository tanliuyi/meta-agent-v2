import { describe, expect, it } from "vitest";
import { alignedDiffRows } from "../src/renderer/src/components/panel/scm/scm-diff-model.ts";
import type { TextFile } from "../src/shared/contracts.ts";
import type { ScmDiffHunk } from "../src/shared/scm-contracts.ts";

function file(content: string): TextFile {
  return { path: "example.ts", content, language: "ts" };
}

describe("alignedDiffRows", () => {
  it("inserts an empty original-side visual row for an added line", () => {
    const hunks: ScmDiffHunk[] = [{ originalStart: 2, originalLines: 0, modifiedStart: 3, modifiedLines: 1 }];
    expect(alignedDiffRows({ original: file("a\nb\nc"), modified: file("a\nb\nx\nc"), hunks })).toEqual([
      { originalLine: 0, modifiedLine: 0 },
      { originalLine: 1, modifiedLine: 1 },
      { originalLine: undefined, modifiedLine: 2, originalKind: undefined, modifiedKind: "added" },
      { originalLine: 2, modifiedLine: 3 },
    ]);
  });

  it("inserts an empty modified-side visual row for a deleted line", () => {
    const hunks: ScmDiffHunk[] = [{ originalStart: 2, originalLines: 1, modifiedStart: 1, modifiedLines: 0 }];
    expect(alignedDiffRows({ original: file("a\nb\nc"), modified: file("a\nc"), hunks })).toEqual([
      { originalLine: 0, modifiedLine: 0 },
      { originalLine: 1, modifiedLine: undefined, originalKind: "removed", modifiedKind: undefined },
      { originalLine: 2, modifiedLine: 1 },
    ]);
  });
});
