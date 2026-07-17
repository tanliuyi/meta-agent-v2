import type { PendingAttachment, ThreadComposerState } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { submitRunningMessage } from "../src/renderer/src/runtime/running-session.ts";

describe("running session submission", () => {
  it("enqueue 成功后清空 Composer，但不提前追加排队消息", async () => {
    const enqueue = vi.fn(async () => {});
    const resetComposer = vi.fn(async () => {});

    await submitRunningMessage(
      composerState("  steer message  "),
      { projectId: "project", threadId: "thread", mode: "steer" },
      enqueue,
      { resetComposer },
    );

    expect(enqueue).toHaveBeenCalledWith({
      projectId: "project",
      threadId: "thread",
      mode: "steer",
      text: "steer message",
      images: [],
    });
    expect(resetComposer).toHaveBeenCalledOnce();
  });

  it("运行中拒绝仅图片消息并保留 Composer", async () => {
    const enqueue = vi.fn(async () => {});
    const resetComposer = vi.fn(async () => {});

    await expect(
      submitRunningMessage(
        composerState("", [pendingAttachment()]),
        { projectId: "project", threadId: "thread", mode: "followUp" },
        enqueue,
        { resetComposer },
      ),
    ).rejects.toThrow("运行中的排队消息必须包含文字");

    expect(enqueue).not.toHaveBeenCalled();
    expect(resetComposer).not.toHaveBeenCalled();
  });

  it("enqueue 失败时保留 Composer", async () => {
    const resetComposer = vi.fn(async () => {});

    await expect(
      submitRunningMessage(
        composerState("steer message"),
        { projectId: "project", threadId: "thread", mode: "steer" },
        async () => {
          throw new Error("enqueue failed");
        },
        { resetComposer },
      ),
    ).rejects.toThrow("enqueue failed");
    expect(resetComposer).not.toHaveBeenCalled();
  });
});

function composerState(text: string, attachments: ThreadComposerState["attachments"] = []): ThreadComposerState {
  return {
    type: "thread",
    canCancel: true,
    canSend: true,
    isEditing: false,
    isEmpty: false,
    text,
    role: "user",
    attachments,
    runConfig: {},
    attachmentAccept: "image/*",
    dictation: undefined,
    quote: undefined,
    queue: [],
  };
}

function pendingAttachment(): PendingAttachment {
  return {
    id: "pending",
    type: "image",
    name: "queued.png",
    contentType: "image/png",
    file: new File(["image"], "queued.png", { type: "image/png" }),
    status: { type: "requires-action", reason: "composer-send" },
  };
}
