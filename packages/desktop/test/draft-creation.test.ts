import { describe, expect, it, vi } from "vitest";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import { ensureDraftCreateRequestId, materializeDraftSession } from "../src/renderer/src/state/draft-creation.ts";
import type { SessionBootstrap, SessionCommandResult } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("draft creation request", () => {
  it("同一 Project 的创建重试复用 request ID", () => {
    const requestIds = new Map<string, string>();
    const createId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");

    expect(ensureDraftCreateRequestId(requestIds, "project", createId)).toBe("first");
    expect(ensureDraftCreateRequestId(requestIds, "project", createId)).toBe("first");
    expect(createId).toHaveBeenCalledOnce();

    requestIds.delete("project");
    expect(ensureDraftCreateRequestId(requestIds, "project", createId)).toBe("second");
  });

  it("按 create、attach、activate、prompt 顺序提交", async () => {
    const harness = createHarness();

    await expect(materializeDraftSession(input(), harness.dependencies)).resolves.toEqual({
      target: { projectId: "project", threadId: "thread" },
      outcome: "accepted",
    });

    expect(harness.order).toEqual(["create", "attach", "activate", "prompt", "catalog"]);
    expect(harness.onMaterialized).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread" }));
  });

  it("attach 失败时 retire cache 并删除未提交 session", async () => {
    const harness = createHarness();
    harness.ensureAttached.mockRejectedValueOnce(new Error("attach failed"));

    await expect(materializeDraftSession(input(), harness.dependencies)).rejects.toThrow("attach failed");

    expect(harness.retire).toHaveBeenCalledWith("project\u0000thread");
    expect(harness.remove).toHaveBeenCalledWith("project", "thread");
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(harness.onMaterialized).not.toHaveBeenCalled();
  });

  it("preflight 失败时清理 session，未知结果时保留 session", async () => {
    const rejected = createHarness({ accepted: false, queued: false, error: "rejected" });

    await expect(materializeDraftSession(input(), rejected.dependencies)).rejects.toThrow("rejected");
    expect(rejected.retire).toHaveBeenCalledOnce();
    expect(rejected.remove).toHaveBeenCalledOnce();
    expect(rejected.onMaterialized).not.toHaveBeenCalled();

    const unknown = createHarness();
    unknown.prompt.mockRejectedValueOnce(new Error("unknown outcome"));
    await expect(materializeDraftSession(input(), unknown.dependencies)).resolves.toEqual({
      target: { projectId: "project", threadId: "thread" },
      outcome: "unknown",
    });
    expect(unknown.retire).not.toHaveBeenCalled();
    expect(unknown.remove).not.toHaveBeenCalled();
    expect(unknown.onMaterialized).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread" }));
  });
});

function input() {
  return {
    projectId: "project",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "off" as const,
    extensionSetGeneration: "extensions-generation",
    text: "hello",
    images: [],
  };
}

function createHarness(promptResult: SessionCommandResult = { accepted: true, queued: false }) {
  const order: string[] = [];
  const create = vi.fn(async () => {
    order.push("create");
    return bootstrap();
  });
  const ensureAttached = vi.fn(async () => {
    order.push("attach");
    return createSessionRecord({ projectId: "project", threadId: "thread" });
  });
  const setActiveKey = vi.fn(() => order.push("activate"));
  const prompt = vi.fn(async () => {
    order.push("prompt");
    return promptResult;
  });
  const remove = vi.fn(async () => undefined);
  const retire = vi.fn(async () => undefined);
  const onMaterialized = vi.fn(() => order.push("catalog"));
  return {
    order,
    ensureAttached,
    prompt,
    remove,
    retire,
    onMaterialized,
    dependencies: {
      requestIds: new Map<string, string>(),
      sessions: { create, prompt, remove },
      cache: { ensureAttached, setActiveKey, retire },
      onMaterialized,
    },
  };
}

function bootstrap(): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId: "thread",
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "thread",
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId: "thread",
      title: "新会话",
      updatedAt: 0,
      cwd: "/workspace",
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionSet: { generation: "extensions-generation", diagnostics: [], reloadRequired: false },
      extensionHost: { statuses: {}, widgets: [] },
    },
  };
}
