import { describe, expect, it } from "vitest";
import { mergeSessionControl } from "../src/renderer/src/state/session-control-identity.ts";
import { PROTOCOL_VERSION, type SessionControlState } from "../src/shared/contracts.ts";

describe("mergeSessionControl", () => {
  it("revision 推进时复用 structured-clone 中语义未变化的嵌套引用", () => {
    const previous = control();
    const incoming = structuredClone({ ...previous, revision: 2 });

    const merged = mergeSessionControl(previous, incoming);

    expect(merged).not.toBe(previous);
    expect(merged.revision).toBe(2);
    expect(merged.queueModes).toBe(previous.queueModes);
    expect(merged.model).toBe(previous.model);
    expect(merged.models).toBe(previous.models);
    expect(merged.commands).toBe(previous.commands);
    expect(merged.thinkingLevels).toBe(previous.thinkingLevels);
    expect(merged.context).toBe(previous.context);
    expect(merged.readiness).toBe(previous.readiness);
    expect(merged.hostRequests).toBe(previous.hostRequests);
    expect(merged.extensionSet).toBe(previous.extensionSet);
    expect(merged.extensionHost).toBe(previous.extensionHost);
  });

  it("只替换变化的 extension widget，同时保留其他 extension 引用", () => {
    const previous = control();
    const incoming = structuredClone({ ...previous, revision: 2 });
    incoming.extensionHost.widgets[0] = { ...incoming.extensionHost.widgets[0]!, lines: ["changed"] };

    const merged = mergeSessionControl(previous, incoming);

    expect(merged.extensionHost).not.toBe(previous.extensionHost);
    expect(merged.extensionHost.widgets).not.toBe(previous.extensionHost.widgets);
    expect(merged.extensionHost.statuses).toBe(previous.extensionHost.statuses);
    expect(merged.models).toBe(previous.models);
  });
});

function control(): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: 1,
    projectId: "project",
    threadId: "thread",
    title: "会话",
    updatedAt: 1,
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
    hostRequests: [
      {
        id: "request",
        type: "select",
        title: "选择",
        options: ["A", "B"],
        createdAt: 1,
      },
    ],
    extensionSet: { generation: "extensions-generation", diagnostics: [], reloadRequired: false },
    extensionHost: {
      statuses: { extension: "ready" },
      composerCommand: { hostId: "host", revision: 1, mode: "replace", text: "draft" },
      widgets: [{ key: "widget", lines: ["line"], placement: "aboveEditor" }],
    },
  };
}
