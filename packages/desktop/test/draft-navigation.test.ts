import { describe, expect, it } from "vitest";
import {
  draftSearch,
  resolveDraftProjectId,
  resolveRootTarget,
  validateDraftSearch,
} from "../src/renderer/src/state/session-navigation.ts";
import { GENERAL_WORKSPACE_ID } from "../src/shared/contracts.ts";

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

  it("没有用户 Project 时兜底选择通用工作区", () => {
    const projects = [{ id: GENERAL_WORKSPACE_ID }];

    expect(resolveDraftProjectId(projects, undefined, null, true)).toBe(GENERAL_WORKSPACE_ID);
    expect(resolveDraftProjectId(projects, "project-x", null, true)).toBe(GENERAL_WORKSPACE_ID);
    // allowFallback=false 时不自动选择
    expect(resolveDraftProjectId(projects, undefined, null, false)).toBeNull();
  });

  it("通用工作区存在时不拦截显式用户 Project 选择", () => {
    const projects = [{ id: GENERAL_WORKSPACE_ID }, { id: "project-b" }];

    expect(resolveDraftProjectId(projects, "project-b", null, true)).toBe("project-b");
    expect(resolveDraftProjectId(projects, undefined, "project-b", true)).toBe("project-b");
  });

  describe("resolveRootTarget", () => {
    const withGeneral = [
      { id: GENERAL_WORKSPACE_ID, available: true },
      { id: "project-b", available: true },
    ];
    const projectsOnly = [{ id: "project-b", available: true }];

    it("general 可用时优先于其他选项", () => {
      expect(resolveRootTarget(withGeneral, null, null)).toBe(GENERAL_WORKSPACE_ID);
    });

    it("general 优先于 draftProjectId 和 activeProjectId", () => {
      // 即使 draft 和 active 都指向真实项目，general 仍优先
      expect(resolveRootTarget(withGeneral, "project-b", "project-b")).toBe(GENERAL_WORKSPACE_ID);
      expect(resolveRootTarget(withGeneral, GENERAL_WORKSPACE_ID, null)).toBe(GENERAL_WORKSPACE_ID);
    });

    it("没有 general 时回退到 draft/active/可用 Project", () => {
      expect(resolveRootTarget(projectsOnly, null, null)).toBe("project-b");
      expect(resolveRootTarget(projectsOnly, "nonexistent", null)).toBe("project-b");
    });

    it("无可用项返回 null", () => {
      expect(resolveRootTarget([], null, null)).toBeNull();
    });
  });
});
