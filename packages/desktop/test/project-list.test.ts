import { describe, expect, it } from "vitest";
import { moveProjectId, reorderProjectIds } from "../src/renderer/src/components/layout/project-list.tsx";
import type { Project } from "../src/shared/contracts.ts";

const projects: Project[] = ["first", "second", "third"].map((id, index) => ({
  id,
  name: id,
  cwd: `C:/${id}`,
  lastOpenedAt: index,
  available: true,
}));

describe("ProjectList drag order", () => {
  it("将项目移动到目标项之前", () => {
    expect(reorderProjectIds(projects, "third", "first", "before")).toEqual(["third", "first", "second"]);
  });

  it("将项目移动到目标项之后", () => {
    expect(reorderProjectIds(projects, "first", "second", "after")).toEqual(["second", "first", "third"]);
  });

  it("通过键盘可达操作上移或下移项目", () => {
    expect(moveProjectId(projects, "second", -1)).toEqual(["second", "first", "third"]);
    expect(moveProjectId(projects, "second", 1)).toEqual(["first", "third", "second"]);
    expect(moveProjectId(projects, "first", -1)).toBeNull();
    expect(moveProjectId(projects, "third", 1)).toBeNull();
    expect(moveProjectId(projects, "missing", 1)).toBeNull();
  });

  it("顺序没有变化或 ID 无效时不提交", () => {
    expect(reorderProjectIds(projects, "first", "second", "before")).toBeNull();
    expect(reorderProjectIds(projects, "first", "first", "after")).toBeNull();
    expect(reorderProjectIds(projects, "missing", "first", "before")).toBeNull();
  });
});
