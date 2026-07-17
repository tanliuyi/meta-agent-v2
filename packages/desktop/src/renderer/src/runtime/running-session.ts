import type { ThreadComposerState } from "@assistant-ui/react";
import type { SendInput } from "../../../shared/contracts.ts";
import { prepareDraftSubmission } from "./draft-session.ts";
import { toPiImageInputs } from "./image-attachments.ts";

interface RunningSubmissionTarget {
  resetComposer(): Promise<void>;
}

/** 将运行中的 steer/follow-up 提交给 Pi 队列；消息由消费事件插入列表。 */
export async function submitRunningMessage(
  state: ThreadComposerState,
  input: Pick<SendInput, "projectId" | "threadId" | "mode">,
  enqueue: (input: SendInput) => Promise<void>,
  target: RunningSubmissionTarget,
): Promise<void> {
  const text = state.text.trim();
  if (!text) throw new Error("运行中的排队消息必须包含文字");
  const prepared = await prepareDraftSubmission(state);
  await enqueue({
    ...input,
    text,
    images: await toPiImageInputs(prepared.message.attachments ?? []),
  });
  await target.resetComposer();
}
