import { describe, expect, test } from "vitest";
import {
  resolveSubagentSettingsActiveTab,
  subagentSettingsSnapshotForTarget,
  subagentSettingsTargetKey,
} from "../src/renderer/src/features/settings/use-subagent-settings-controller.ts";
import type { SubagentSettingsSnapshot } from "../src/shared/subagent-contracts.ts";

const SNAPSHOT = { revision: "project-a" } as SubagentSettingsSnapshot;

describe("subagent settings controller targets", () => {
  test("assigns distinct keys to personal, system, and project settings", () => {
    expect(subagentSettingsTargetKey(undefined, "user")).toBe("user");
    expect(subagentSettingsTargetKey(undefined, "system")).toBe("system");
    expect(subagentSettingsTargetKey("project-a", "project")).toBe("project:project-a");
    expect(subagentSettingsTargetKey("project-b", "project")).toBe("project:project-b");
  });

  test("falls back synchronously when the selected project becomes unavailable", () => {
    expect(
      resolveSubagentSettingsActiveTab("project:project-a", [
        { id: "project-a", available: false },
        { id: "project-b", available: true },
      ]),
    ).toBe("user");
    expect(resolveSubagentSettingsActiveTab("project:project-b", [{ id: "project-b", available: true }])).toBe(
      "project:project-b",
    );
    expect(resolveSubagentSettingsActiveTab("system", [])).toBe("system");
  });

  test("does not expose a snapshot from a previous settings target", () => {
    const state = { targetKey: "project:project-a", snapshot: SNAPSHOT };

    expect(subagentSettingsSnapshotForTarget(state, "project:project-a")).toBe(SNAPSHOT);
    expect(subagentSettingsSnapshotForTarget(state, "project:project-b")).toBeUndefined();
    expect(subagentSettingsSnapshotForTarget(state, "user")).toBeUndefined();
  });
});
