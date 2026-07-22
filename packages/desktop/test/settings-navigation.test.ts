import { describe, expect, it } from "vitest";
import { settingsReturnSession, validateSettingsSearch } from "../src/renderer/src/state/settings-navigation.ts";

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
});
