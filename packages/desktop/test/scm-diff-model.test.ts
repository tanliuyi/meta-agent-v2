import { describe, expect, it } from "vitest";
import { parseScmDiff } from "../src/renderer/src/components/panel/source-control/scm-diff-model.ts";
import type { GitDiffHunk } from "../src/shared/git-contracts.ts";

const hunks: GitDiffHunk[] = [
  { id: "first", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
  { id: "second", oldStart: 5, oldLines: 0, newStart: 5, newLines: 1 },
];

describe("parseScmDiff", () => {
  it("保留完整上下文和双侧行号，并将操作绑定到每个 hunk 首行", () => {
    const patch = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,5 +1,6 @@",
      " one",
      "-before",
      "+after",
      " three",
      " four",
      "+inserted",
      " five",
    ].join("\n");

    const model = parseScmDiff(patch, hunks);

    expect(model.lines.map((line) => line.text)).toEqual([
      "one",
      "before",
      "after",
      "three",
      "four",
      "inserted",
      "five",
    ]);
    expect(model.lines.map((line) => [line.type, line.oldLineNumber, line.newLineNumber])).toEqual([
      ["context", 1, 1],
      ["remove", 2, undefined],
      ["add", undefined, 2],
      ["context", 3, 3],
      ["context", 4, 4],
      ["add", undefined, 5],
      ["context", 5, 6],
    ]);
    expect(model.lines.filter((line) => line.hunkId).map((line) => line.hunkId)).toEqual(["first", "second"]);
  });

  it("按完整文件最大行号计算稳定 gutter 宽度", () => {
    const patch = ["@@ -98,3 +98,3 @@", " line-98", "-line-99", "+changed", " line-100"].join("\n");
    const model = parseScmDiff(patch, [{ id: "change", oldStart: 99, oldLines: 1, newStart: 99, newLines: 1 }]);

    expect(model.lineNumberDigits).toBe(3);
    expect(model.maxColumns).toBe("line-100".length);
  });
});
