import type { ThreadComposerState } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import { submitRunningMessage } from "../src/renderer/src/runtime/running-session.ts";

describe("running session submission", () => {
  it("enqueue 成功后追加不启动新 run 的 user message", async () => {
    const enqueue = vi.fn(async () => {});
    const append = vi.fn();
    const resetComposer = vi.fn(async () => {});

    await submitRunningMessage(
      composerState("  steer message  "),
      { projectId: "project", threadId: "thread", mode: "steer" },
      enqueue,
      { append, resetComposer },
    );

    expect(enqueue).toHaveBeenCalledWith({
      projectId: "project",
      threadId: "thread",
      mode: "steer",
      text: "steer message",
      images: [],
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "steer message" }],
        startRun: false,
      }),
    );
    expect(resetComposer).toHaveBeenCalledOnce();
  });

  it("enqueue 失败时不追加消息且保留 Composer", async () => {
    const append = vi.fn();
    const resetComposer = vi.fn(async () => {});

    await expect(
      submitRunningMessage(
        composerState("steer message"),
        { projectId: "project", threadId: "thread", mode: "steer" },
        async () => {
          throw new Error("enqueue failed");
        },
        { append, resetComposer },
      ),
    ).rejects.toThrow("enqueue failed");
    expect(append).not.toHaveBeenCalled();
    expect(resetComposer).not.toHaveBeenCalled();
  });
});

function composerState(text: string): ThreadComposerState {
  return {
    type: "thread",
    canCancel: true,
    canSend: true,
    isEditing: false,
    isEmpty: false,
    text,
    role: "user",
    attachments: [],
    runConfig: {},
    attachmentAccept: "image/*",
    dictation: undefined,
    quote: undefined,
    queue: [],
  };
}
