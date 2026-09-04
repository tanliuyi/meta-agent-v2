import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readActiveRunIndex,
  updateActiveRunIndex,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/active-run-index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("active async run index", () => {
  it("tracks active runs and removes them after a terminal state", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-active-index-"));
    tempDirs.push(root);
    const asyncDir = join(root, "run-1");
    mkdirSync(asyncDir);

    expect(readActiveRunIndex(root)).toBeUndefined();
    updateActiveRunIndex(asyncDir, "running");
    expect(readActiveRunIndex(root)).toEqual(["run-1"]);

    updateActiveRunIndex(asyncDir, "complete");
    expect(readActiveRunIndex(root)).toEqual([]);
  });
});
