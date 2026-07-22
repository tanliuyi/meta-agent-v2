import { describe, expect, it } from "vitest";
import {
  draftSearch,
  resolveDraftProjectId,
  validateDraftSearch,
} from "../src/renderer/src/state/session-navigation.ts";

describe("draft navigation", () => {
  it("从 Project 新建任务时保留 projectId", () => {
    expect(draftSearch("project-a")).toEqual({ projectId: "project-a" });
    expect(validateDraftSearch({ projectId: "project-a" })).toEqual({ projectId: "project-a" });
  });

  it("忽略无效的 Project search 参数", () => {
    expect(draftSearch()).toEqual({});
    expect(validateDraftSearch({ projectId: "" })).toEqual({});
    expect(validateDraftSearch({ projectId: 1 })).toEqual({});
  });

  it("Project catalog 变化时保留有效选择，否则切到首个可用项", () => {
    const projects = [{ id: "project-b" }, { id: "project-c" }];

    expect(resolveDraftProjectId(projects, undefined, null, true)).toBe("project-b");
    expect(resolveDraftProjectId(projects, undefined, "project-b", true)).toBe("project-b");
    expect(resolveDraftProjectId(projects, "project-c", "project-b", true)).toBe("project-c");
  });

  it("当前 Project 被删除后保持未选择，直到用户显式选择", () => {
    const projects = [{ id: "project-b" }];

    expect(resolveDraftProjectId(projects, undefined, "project-a", true)).toBeNull();
    expect(resolveDraftProjectId(projects, undefined, null, false)).toBeNull();
    expect(resolveDraftProjectId([], undefined, "project-a", true)).toBeNull();
  });
});
