import { describe, expect, it } from "vitest";
import {
  settingsReturnDraftProject,
  settingsReturnSession,
  validateSettingsSearch,
} from "../src/renderer/src/state/settings-navigation.ts";

describe("settings navigation", () => {
  it("保留完整 session identity 作为返回目标", () => {
    const search = validateSettingsSearch({ returnProjectId: "project", returnThreadId: "thread" });

    expect(search).toEqual({ returnProjectId: "project", returnThreadId: "thread" });
    expect(settingsReturnSession(search)).toEqual({ projectId: "project", threadId: "thread" });
  });

  it("不使用不完整或非字符串的返回目标", () => {
    expect(validateSettingsSearch({ returnProjectId: "project" })).toEqual({});
    expect(validateSettingsSearch({ returnProjectId: 1, returnThreadId: "thread" })).toEqual({});
    expect(settingsReturnSession({})).toBeNull();
  });

  it("保留新会话草稿项目作为返回目标", () => {
    const search = validateSettingsSearch({ draftProjectId: "project-a" });

    expect(search).toEqual({ draftProjectId: "project-a" });
    expect(settingsReturnDraftProject(search)).toBe("project-a");
    // 草稿项目不影响会话返回目标
    expect(settingsReturnSession(search)).toBeNull();
  });

  it("不使用非字符串的草稿项目", () => {
    expect(validateSettingsSearch({ draftProjectId: 1 })).toEqual({});
    expect(validateSettingsSearch({ draftProjectId: "" })).toEqual({});
    expect(settingsReturnDraftProject({})).toBeNull();
  });
});
