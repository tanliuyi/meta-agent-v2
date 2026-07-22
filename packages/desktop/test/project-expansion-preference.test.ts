import { describe, expect, it } from "vitest";
import {
  parseProjectExpansionPreferences,
  readStoredProjectExpanded,
  writeStoredProjectExpanded,
} from "../src/renderer/src/state/project-expansion-preference.ts";

describe("project expansion preference", () => {
  it("按项目恢复持久化的展开状态，并在没有记录时使用默认值", () => {
    const stored = JSON.stringify({
      version: 1,
      projects: [
        ["expanded", true],
        ["collapsed", false],
      ],
    });

    expect(readStoredProjectExpanded("expanded", false, () => stored)).toBe(true);
    expect(readStoredProjectExpanded("collapsed", true, () => stored)).toBe(false);
    expect(readStoredProjectExpanded("missing", true, () => stored)).toBe(true);
  });

  it("更新单个项目时保留其他项目的状态", () => {
    const stored = JSON.stringify({ version: 1, projects: [["other", true]] });
    let written: string | undefined;

    writeStoredProjectExpanded(
      "project",
      false,
      () => stored,
      (value) => {
        written = value;
      },
    );

    const projects = parseProjectExpansionPreferences(written ?? null);
    expect([...projects]).toEqual([
      ["other", true],
      ["project", false],
    ]);
  });

  it("忽略损坏数据，并在存储不可用时保留交互能力", () => {
    expect(readStoredProjectExpanded("project", true, () => "invalid")).toBe(true);
    expect(
      readStoredProjectExpanded("project", false, () => {
        throw new Error("storage unavailable");
      }),
    ).toBe(false);
    expect(() =>
      writeStoredProjectExpanded(
        "project",
        true,
        () => null,
        () => {
          throw new Error("storage unavailable");
        },
      ),
    ).not.toThrow();
  });
});
