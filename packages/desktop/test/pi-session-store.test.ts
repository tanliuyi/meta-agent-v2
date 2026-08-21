import { describe, expect, it } from "vitest";
import { createSessionRecordStores } from "../src/renderer/src/runtime/pi-session-store.ts";
import { PROTOCOL_VERSION, type SessionControlState } from "../src/shared/contracts.ts";

describe("SessionControlStore", () => {
  it("apply 对语义未变化的嵌套引用复用旧引用，消除无谓刷新", () => {
    const { control } = createSessionRecordStores();
    const initial = controlState(1);
    control.replace(initial);

    // 模拟主进程每次 agent 事件重建整包推送：revision 推进，其余字段语义相同。
    for (let revision = 2; revision <= 5; revision += 1) {
      control.apply(structuredClone({ ...initial, revision }));
    }

    const snapshot = control.getSnapshot();
    expect(snapshot?.revision).toBe(5);
    expect(snapshot).not.toBe(initial);
    expect(snapshot?.commands).toBe(initial.commands);
    expect(snapshot?.models).toBe(initial.models);
    expect(snapshot?.thinkingLevels).toBe(initial.thinkingLevels);
    expect(snapshot?.extensionHost).toBe(initial.extensionHost);
  });

  it("apply 忽略 revision 未推进的旧推送", () => {
    const { control } = createSessionRecordStores();
    const initial = controlState(2);
    control.replace(initial);
    control.apply(structuredClone({ ...initial, revision: 1 }));
    expect(control.getSnapshot()).toBe(initial);
  });

  it("命令内容变化时替换 commands 引用", () => {
    const { control } = createSessionRecordStores();
    const initial = controlState(1);
    control.replace(initial);

    const next = structuredClone({ ...initial, revision: 2 });
    next.commands = [...next.commands, { name: "new", description: "新命令", source: "extension" }];
    control.apply(next);

    expect(control.getSnapshot()?.commands).not.toBe(initial.commands);
    expect(control.getSnapshot()?.commands).toHaveLength(2);
  });
});

function controlState(revision: number): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision,
    projectId: "project",
    threadId: "thread",
    title: "会话",
    updatedAt: revision,
    cwd: "/workspace",
    running: false,
    queueModes: { steering: "all", followUp: "all" },
    model: { provider: "provider", id: "model", name: "Model" },
    models: [{ provider: "provider", id: "model", name: "Model", contextWindow: 128_000, thinking: true }],
    commands: [{ name: "help", description: "帮助", source: "builtin" }],
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium"],
    context: { tokens: 10, contextWindow: 128_000, percent: 0.1 },
    readiness: { state: "ready" },
    hostRequests: [],
    extensionHost: {
      statuses: {},
      widgets: [],
    },
  };
}
