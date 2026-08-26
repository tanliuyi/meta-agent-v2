import { describe, expect, it } from "vitest";
import { isSessionTabCommand, sessionTabTargetForCommand } from "../src/renderer/src/state/keyboard-shortcuts.ts";

const records = [
  { identity: { projectId: "project-a", threadId: "thread-a" } },
  { identity: { projectId: "project-b", threadId: "thread-b" } },
];

describe("session tab shortcut fallback", () => {
  it("标签组件未挂载时按常驻 session cache 顺序解析目标", () => {
    expect(sessionTabTargetForCommand("session.tab.activate.2", records)?.identity).toEqual({
      projectId: "project-b",
      threadId: "thread-b",
    });
  });

  it("没有对应会话或不是标签命令时返回 undefined", () => {
    expect(sessionTabTargetForCommand("session.tab.activate.3", records)).toBeUndefined();
    expect(sessionTabTargetForCommand("task.new", records)).toBeUndefined();
    expect(isSessionTabCommand("session.tab.activate.1")).toBe(true);
    expect(isSessionTabCommand("task.new")).toBe(false);
  });
});
