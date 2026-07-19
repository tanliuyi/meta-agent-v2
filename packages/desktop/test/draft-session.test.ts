import type { CompleteAttachment, PendingAttachment, ThreadComposerState } from "@assistant-ui/react";
import { describe, expect, it, vi } from "vitest";
import {
  type ComposerReseedTarget,
  prepareDraftSubmission,
  reseedComposer,
  runDraftSubmissionSingleFlight,
} from "../src/renderer/src/runtime/draft-session.ts";

const quote = { text: "引用内容", messageId: "message" };

describe("new session draft submission", () => {
  it("在 create 前完成附件并保留 Composer 的结构化语义", async () => {
    const pending = pendingAttachment();
    const complete = completeAttachment();
    const completePending = vi.fn(async () => complete);

    const prepared = await prepareDraftSubmission(
      composerState({ text: "  保留正文  ", attachments: [pending] }),
      completePending,
    );

    expect(completePending).toHaveBeenCalledWith(pending);
    expect(prepared.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "  保留正文  " }],
      attachments: [complete],
      runConfig: { custom: { mode: "draft" } },
      metadata: { custom: { quote } },
    });
    expect(prepared.reseed.attachments).toEqual([
      {
        id: complete.id,
        type: complete.type,
        name: complete.name,
        contentType: complete.contentType,
        content: complete.content,
      },
    ]);
  });

  it("附件 prepare 失败时直接拒绝且不修改原 Composer state", async () => {
    const state = composerState({ text: "prompt", attachments: [pendingAttachment()] });
    const snapshot = structuredClone(state);

    await expect(
      prepareDraftSubmission(state, async () => {
        throw new Error("无法读取附件");
      }),
    ).rejects.toThrow("无法读取附件");
    expect(state).toEqual(snapshot);
  });

  it("并行完成多个 pending 附件，并保持原始顺序", async () => {
    const first = pendingAttachment("first");
    const second = pendingAttachment("second");
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const preparing = prepareDraftSubmission(composerState({ attachments: [first, second] }), async (attachment) => {
      started.push(attachment.id);
      await new Promise<void>((resolve) => releases.set(attachment.id, resolve));
      return completeAttachment(attachment.id);
    });

    expect(started).toEqual(["first", "second"]);
    releases.get("second")?.();
    releases.get("first")?.();
    const prepared = await preparing;
    expect(prepared.message.attachments?.map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("拒绝没有正文和附件的无效 submit", async () => {
    await expect(prepareDraftSubmission(composerState())).rejects.toThrow("请输入消息或添加图片");
  });

  it("在 committed runtime 重建后完整 reseed Composer", async () => {
    const target: ComposerReseedTarget = {
      setText: vi.fn(),
      setRole: vi.fn(),
      setRunConfig: vi.fn(),
      setQuote: vi.fn(),
      addAttachment: vi.fn(async () => {}),
    };
    const attachment = completeAttachment();
    const prepared = await prepareDraftSubmission(composerState({ text: "prompt", attachments: [attachment] }));

    await reseedComposer(target, prepared.reseed);

    expect(target.setText).toHaveBeenCalledWith("prompt");
    expect(target.setRole).toHaveBeenCalledWith("user");
    expect(target.setRunConfig).toHaveBeenCalledWith({ custom: { mode: "draft" } });
    expect(target.setQuote).toHaveBeenCalledWith(quote);
    expect(target.addAttachment).toHaveBeenCalledWith(prepared.reseed.attachments[0]);
  });

  it("reseed 按顺序提交共享 Composer 附件状态", async () => {
    const releases: Array<() => void> = [];
    const target: ComposerReseedTarget = {
      setText: vi.fn(),
      setRole: vi.fn(),
      setRunConfig: vi.fn(),
      setQuote: vi.fn(),
      addAttachment: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      ),
    };
    const reseeding = reseedComposer(target, {
      text: "",
      role: "user",
      runConfig: undefined,
      quote: undefined,
      attachments: [completeAttachment("first"), completeAttachment("second")],
    });

    expect(target.addAttachment).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await Promise.resolve();
    expect(target.addAttachment).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await reseeding;
  });

  it("重复 submit 复用同一个首次发送事务", async () => {
    const reference = { current: null as Promise<void> | null };
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(() => pending);

    const first = runDraftSubmissionSingleFlight(reference, task);
    const duplicate = runDraftSubmissionSingleFlight(reference, task);

    expect(duplicate).toBe(first);
    expect(task).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    expect(reference.current).toBeNull();
  });
});

function composerState(
  overrides: Partial<Pick<ThreadComposerState, "text" | "attachments">> = {},
): ThreadComposerState {
  const text = overrides.text ?? "";
  const attachments = overrides.attachments ?? [];
  return {
    type: "thread",
    canCancel: false,
    canSend: true,
    isEditing: true,
    isEmpty: !text.trim() && attachments.length === 0,
    text,
    role: "user",
    attachments,
    runConfig: { custom: { mode: "draft" } },
    attachmentAccept: "image/*",
    dictation: undefined,
    quote,
    queue: [],
  };
}

function pendingAttachment(id = "pending"): PendingAttachment {
  return {
    id,
    type: "image",
    name: "draft.png",
    contentType: "image/png",
    file: new File(["image"], "draft.png", { type: "image/png" }),
    status: { type: "requires-action", reason: "composer-send" },
  };
}

function completeAttachment(id = "complete"): CompleteAttachment {
  return {
    id,
    type: "image",
    name: "draft.png",
    contentType: "image/png",
    content: [{ type: "image", image: "data:image/png;base64,aW1hZ2U=" }],
    status: { type: "complete" },
  };
}
