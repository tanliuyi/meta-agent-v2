import type { AppendMessage } from "@assistant-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiCommandCoordinator, resolveReloadUserEntry } from "../src/renderer/src/runtime/pi-command-coordinator.ts";
import type { PiThreadSnapshot, SessionPromptInput } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const target = { projectId: "project", threadId: "thread", generation: 1 };

describe("PiCommandCoordinator", () => {
  const prompt = vi.fn();
  const edit = vi.fn();
  const reload = vi.fn();
  const clearQueue = vi.fn();
  const setText = vi.fn();
  const addAttachment = vi.fn();
  const getState = vi.fn(() => ({ text: "current draft" }));
  const resolveReloadTarget = vi.fn((parentId: string | null) => parentId);
  const report = vi.fn();
  let phase: PiThreadSnapshot["phase"];

  beforeEach(() => {
    vi.clearAllMocks();
    prompt.mockResolvedValue({ accepted: true, queued: false });
    edit.mockResolvedValue({ accepted: true, queued: false });
    reload.mockResolvedValue({ accepted: true, queued: false });
    addAttachment.mockResolvedValue(undefined);
    getState.mockReturnValue({ text: "current draft" });
    phase = "idle";
    resolveReloadTarget.mockImplementation((parentId: string | null) => parentId);
    vi.stubGlobal("window", {
      desktop: { sessions: { prompt, edit, reload, clearQueue } },
    });
  });

  it("idle 与 running enqueue 都统一调用 sessions.prompt，并保留 desiredMode", async () => {
    const coordinator = createCoordinator();

    coordinator.enqueue(userMessage("first"), { steer: false });
    phase = "running";
    coordinator.enqueue(userMessage("second"), { steer: true });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: "project", threadId: "thread", text: "first", desiredMode: "followUp" }),
    );
    expect(prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "second", desiredMode: "steer" }));
  });

  it("void queue callback 自行捕获 preflight rejection 并恢复当前 Composer", async () => {
    const error = new Error("preflight failed");
    prompt.mockRejectedValueOnce(error);
    const coordinator = createCoordinator();

    expect(coordinator.enqueue(userMessage("retry me"), { steer: false })).toBeUndefined();

    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(error));
    expect(setText).toHaveBeenCalledWith("retry me");
  });

  it("accepted false 结果按 preflight rejection 恢复当前 Composer", async () => {
    prompt.mockResolvedValueOnce({ accepted: false, queued: false, error: "missing credentials" });
    const coordinator = createCoordinator();

    coordinator.enqueue(userMessage("retry me"), { steer: false });

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(setText).toHaveBeenCalledWith("retry me");
  });

  it("Pi 已接受后的真实 command error 只报告，不恢复 Composer", async () => {
    prompt.mockResolvedValueOnce({ accepted: true, queued: false, error: "provider failed" });
    const coordinator = createCoordinator();

    coordinator.enqueue(userMessage("accepted"), { steer: false });

    await vi.waitFor(() => expect(report).toHaveBeenCalledWith("provider failed"));
    expect(setText).not.toHaveBeenCalled();
  });

  it("执行时重新读取 phase，非 idle/running submit fail fast 并恢复 Composer", async () => {
    const coordinator = createCoordinator();
    phase = "compacting";

    coordinator.enqueue(userMessage("blocked"), { steer: false });

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    const reported = report.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    if (!(reported instanceof Error)) throw new Error("reported error missing");
    expect(reported.message).toMatch(/不接受/);
    expect(prompt).not.toHaveBeenCalled();
    expect(setText).toHaveBeenCalledWith("blocked");
  });

  it("running 阶段拒绝仅包含图片的输入并恢复附件", async () => {
    phase = "running";
    const coordinator = createCoordinator();
    const message: AppendMessage = {
      ...userMessage(""),
      attachments: [imageAttachment()],
    };

    coordinator.enqueue(message, { steer: false });

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(prompt).not.toHaveBeenCalled();
    expect(addAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "image" }));
  });

  it("edit 使用 sourceId，reload 使用 parentId", async () => {
    const coordinator = createCoordinator();
    const edited = { ...userMessage("edited"), sourceId: "user-entry" };
    resolveReloadTarget.mockReturnValueOnce("resolved-user-entry");

    await coordinator.edit(edited);
    await coordinator.reload("parent-user-entry");

    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "user-entry", text: "edited" }));
    expect(resolveReloadTarget).toHaveBeenCalledWith("parent-user-entry");
    expect(reload).toHaveBeenCalledWith(expect.objectContaining({ parentId: "resolved-user-entry" }));
  });

  it("不支持单项 queue 操作 fail fast，framework clear 只记录 advisory", () => {
    const coordinator = createCoordinator();

    expect(() => coordinator.unsupportedQueueOperation()).toThrow("不支持单项 remove/promote");
    expect(coordinator.observeFrameworkClear()).toBeUndefined();
    expect(clearQueue).not.toHaveBeenCalled();
  });

  it("显式 clear 使用 Pi 返回顺序恢复文本，并为 Desktop-origin item 恢复附件", async () => {
    const coordinator = createCoordinator();
    prompt.mockResolvedValueOnce({ accepted: true, queued: true });
    const message: AppendMessage = {
      ...userMessage("queued"),
      attachments: [imageAttachment()],
    };
    coordinator.enqueue(message, { steer: true });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    const input = prompt.mock.calls[0]?.[0] as SessionPromptInput | undefined;
    if (!input) throw new Error("prompt input missing");
    const { requestId } = input;
    clearQueue.mockImplementationOnce(async () => {
      coordinator.observeQueue([]);
      return { steering: ["queued"], followUp: [] };
    });

    await coordinator.clearQueue([
      { id: `queue:${requestId}`, mode: "steer", prompt: "queued", source: "desktop", requestId },
    ]);

    expect(setText).toHaveBeenCalledWith("queued\n\ncurrent draft");
    expect(addAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "image", content: [{ type: "image", image: "data:image/png;base64,aW1hZ2U=" }] }),
    );
  });

  it("queue item 被消费后释放原始图片输入", async () => {
    const coordinator = createCoordinator();
    prompt.mockResolvedValueOnce({ accepted: true, queued: true });
    coordinator.enqueue({ ...userMessage("queued"), attachments: [imageAttachment()] }, { steer: true });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    const input = prompt.mock.calls[0]?.[0] as SessionPromptInput | undefined;
    if (!input) throw new Error("prompt input missing");
    const item = {
      id: `queue:${input.requestId}`,
      mode: "steer" as const,
      prompt: "queued",
      source: "desktop" as const,
      requestId: input.requestId,
    };
    coordinator.observeQueue([item]);
    coordinator.observeQueue([]);
    clearQueue.mockResolvedValueOnce({ steering: ["queued"], followUp: [] });

    await coordinator.clearQueue([item]);

    expect(setText).toHaveBeenCalledWith("queued\n\ncurrent draft");
    expect(addAttachment).not.toHaveBeenCalled();
  });

  it("reload target 跨过 notice 解析最近的 persisted user entry", () => {
    const snapshot: PiThreadSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "thread",
      cursor: 0,
      headId: "notice",
      queue: [],
      phase: "idle",
      nodes: [
        {
          id: "user",
          sourceEntryId: "user-entry",
          parentId: null,
          createdAt: 1,
          kind: "user",
          content: [{ type: "text", text: "question" }],
          delivery: { state: "persisted" },
        },
        {
          id: "notice",
          sourceEntryId: "notice-entry",
          parentId: "user",
          createdAt: 2,
          kind: "notice",
          noticeType: "custom",
          title: "context",
          content: { type: "text", text: "context" },
        },
      ],
    };

    expect(resolveReloadUserEntry(snapshot, "notice")).toBe("user-entry");
  });

  function createCoordinator(): PiCommandCoordinator {
    return new PiCommandCoordinator({
      getTarget: () => target,
      getComposer: () => ({ getState, setText, addAttachment }),
      getPhase: () => phase,
      resolveReloadTarget,
      report,
    });
  }
});

function userMessage(text: string): AppendMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    attachments: [],
    createdAt: new Date(0),
    metadata: { custom: {} },
    parentId: null,
    sourceId: null,
    runConfig: undefined,
  };
}

function imageAttachment(): NonNullable<AppendMessage["attachments"]>[number] {
  return {
    id: "image",
    type: "image",
    name: "image.png",
    contentType: "image/png",
    status: { type: "complete" },
    content: [{ type: "image", image: "data:image/png;base64,aW1hZ2U=" }],
  };
}
