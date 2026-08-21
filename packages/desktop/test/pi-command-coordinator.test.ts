import type { AppendMessage } from "@assistant-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiCommandCoordinator } from "../src/renderer/src/runtime/pi-command-coordinator.ts";
import type { PiThreadSnapshot } from "../src/shared/contracts.ts";

const target = { projectId: "project", threadId: "thread", generation: 1 };

describe("PiCommandCoordinator", () => {
  const prompt = vi.fn();
  const cancel = vi.fn();
  const setText = vi.fn();
  const setQuote = vi.fn();
  const addAttachment = vi.fn();
  const getState = vi.fn(() => ({ text: "current draft" }));
  const report = vi.fn();
  let phase: PiThreadSnapshot["phase"];

  beforeEach(() => {
    vi.clearAllMocks();
    prompt.mockResolvedValue({ accepted: true, queued: false });
    cancel.mockResolvedValue(undefined);
    addAttachment.mockResolvedValue(undefined);
    getState.mockReturnValue({ text: "current draft" });
    phase = "idle";
    vi.stubGlobal("window", { desktop: { sessions: { prompt, cancel } } });
  });

  it("idle 与 running enqueue 都统一调用 sessions.prompt，并保留 desiredMode", async () => {
    const coordinator = createCoordinator();

    coordinator.enqueue(userMessage("first"));
    phase = "running";
    coordinator.steer(userMessage("second"));

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: "project", threadId: "thread", text: "first", desiredMode: "followUp" }),
    );
    expect(prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "second", desiredMode: "steer" }));
  });

  it("将 assistant-ui quote metadata 作为结构化 IPC 字段发送", async () => {
    const coordinator = createCoordinator();
    coordinator.enqueue({
      ...userMessage("请解释这段内容"),
      metadata: { custom: { quote: { text: "第一行\n第二行", messageId: "assistant-1" } } },
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "请解释这段内容",
        quote: { text: "第一行\n第二行", messageId: "assistant-1" },
      }),
    );
  });

  it("将多条 quote metadata 作为结构化 IPC 数组发送", async () => {
    const coordinator = createCoordinator();
    const quotes = [
      { text: "第一段", messageId: "assistant-1" },
      { text: "第二段", messageId: "assistant-2" },
    ];
    coordinator.enqueue({
      ...userMessage("请比较"),
      metadata: { custom: { quote: { ...quotes[0], quotes } } },
    });

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ text: "请比较", quotes }));
  });

  it("preflight rejection 恢复 Composer 输入与附件", async () => {
    prompt.mockRejectedValueOnce(new Error("preflight failed"));
    const coordinator = createCoordinator();

    coordinator.enqueue({ ...userMessage("retry me"), attachments: [imageAttachment()] });

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(setText).toHaveBeenCalledWith("retry me");
    expect(addAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "image" }));
  });

  it("preflight rejection 恢复多条引用", async () => {
    prompt.mockRejectedValueOnce(new Error("preflight failed"));
    const coordinator = createCoordinator();
    const quotes = [
      { text: "第一段", messageId: "assistant-1" },
      { text: "第二段", messageId: "assistant-2" },
    ];

    coordinator.enqueue({
      ...userMessage("retry me"),
      metadata: { custom: { quote: { ...quotes[0], quotes } } },
    });

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(setQuote).toHaveBeenCalledWith(expect.objectContaining({ quotes }));
  });

  it("accepted false 按 preflight rejection 恢复 Composer", async () => {
    prompt.mockResolvedValueOnce({ accepted: false, queued: false, error: "missing credentials" });
    const coordinator = createCoordinator();

    coordinator.enqueue(userMessage("retry me"));

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(setText).toHaveBeenCalledWith("retry me");
  });

  it("Pi 已接受后的 command error 只报告，不恢复 Composer", async () => {
    prompt.mockResolvedValueOnce({ accepted: true, queued: false, error: "provider failed" });
    const coordinator = createCoordinator();

    coordinator.enqueue(userMessage("accepted"));

    await vi.waitFor(() => expect(report).toHaveBeenCalledWith("provider failed"));
    expect(setText).not.toHaveBeenCalled();
  });

  it("非 idle/running 阶段拒绝 submit 并恢复 Composer", async () => {
    const coordinator = createCoordinator();
    phase = "compacting";

    coordinator.enqueue(userMessage("blocked"));

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(prompt).not.toHaveBeenCalled();
    expect(setText).toHaveBeenCalledWith("blocked");
  });

  it("running 阶段拒绝仅包含图片的输入并恢复附件", async () => {
    phase = "running";
    const coordinator = createCoordinator();

    coordinator.enqueue({ ...userMessage(""), attachments: [imageAttachment()] });

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(prompt).not.toHaveBeenCalled();
    expect(addAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: "image" }));
  });

  it("cancel 中止系统 Pi 并清除本地 pending queue bookkeeping", async () => {
    const coordinator = createCoordinator();
    prompt.mockResolvedValueOnce({ accepted: true, queued: true });
    coordinator.enqueue(userMessage("queued"));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    await coordinator.cancel();
    coordinator.observeQueue([]);

    expect(cancel).toHaveBeenCalledWith("project", "thread");
    expect(setText).not.toHaveBeenCalled();
  });

  it("不支持单项 queue 操作 fail fast", () => {
    const coordinator = createCoordinator();
    expect(() => coordinator.unsupportedQueueOperation()).toThrow("不支持单项 move/edit/remove");
  });

  function createCoordinator(): PiCommandCoordinator {
    return new PiCommandCoordinator({
      getTarget: () => target,
      getComposer: () => ({ getState, setText, setQuote, addAttachment }),
      getPhase: () => phase,
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
