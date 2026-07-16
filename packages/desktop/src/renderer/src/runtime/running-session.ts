import type { CreateAppendMessage, ThreadComposerState } from "@assistant-ui/react";
import type { SendInput } from "../../../shared/contracts.ts";
import { prepareDraftSubmission } from "./draft-session.ts";
import { toPiImageInputs } from "./image-attachments.ts";

interface RunningSubmissionTarget {
  append(message: Exclude<CreateAppendMessage, string>): void;
  resetComposer(): Promise<void>;
}

/** 将运行中的 steer/follow-up 同时提交给 Pi 队列和 assistant-ui 消息列表。 */
export async function submitRunningMessage(
  state: ThreadComposerState,
  input: Pick<SendInput, "projectId" | "threadId" | "mode">,
  enqueue: (input: SendInput) => Promise<void>,
  target: RunningSubmissionTarget,
): Promise<void> {
  const prepared = await prepareDraftSubmission(state);
  const text = state.text.trim();
  await enqueue({
    ...input,
    text,
    images: await toPiImageInputs(prepared.message.attachments ?? []),
  });
  target.append({
    ...prepared.message,
    content: text ? [{ type: "text", text }] : [],
    startRun: false,
  });
  await target.resetComposer();
}
