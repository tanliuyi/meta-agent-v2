import { describe, expect, test } from "vitest";
import { createUserNameMemoryMutation } from "../src/renderer/src/features/settings/user-profile-memory.ts";
import type { MemoryEntrySummary, MemorySettingsSnapshot } from "../src/shared/memory-settings-contracts.ts";

function snapshot(entries: MemoryEntrySummary[]): MemorySettingsSnapshot {
  return {
    revision: "revision-1",
    collections: [{ target: "user", entries }],
  } as MemorySettingsSnapshot;
}

describe("user profile memory", () => {
  test("首次同步新增用户名到用户资料", () => {
    expect(createUserNameMemoryMutation(snapshot([]), "Tan")).toEqual({
      expectedRevision: "revision-1",
      action: "add",
      target: "user",
      content: "用户名：Tan",
    });
  });

  test("再次同步替换已有用户名条目，不产生重复项", () => {
    expect(
      createUserNameMemoryMutation(
        snapshot([
          { id: "preference", content: "偏好简洁回复" },
          { id: "user-name", content: "用户名：旧名称" },
        ]),
        "Tan",
      ),
    ).toEqual({
      expectedRevision: "revision-1",
      action: "replace",
      target: "user",
      entryId: "user-name",
      content: "用户名：Tan",
    });
  });
});
