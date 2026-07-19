import type {
  CompleteAttachment,
  CreateAppendMessage,
  CreateAttachment,
  PendingAttachment,
  ThreadComposerState,
} from "@assistant-ui/react";
import { imageAttachmentAdapter } from "./image-attachments.ts";

export interface ComposerReseed {
  text: string;
  role: ThreadComposerState["role"];
  runConfig: ThreadComposerState["runConfig"];
  quote: ThreadComposerState["quote"];
  attachments: readonly CreateAttachment[];
}

export interface PreparedComposerSubmission {
  message: Exclude<CreateAppendMessage, string>;
  reseed: ComposerReseed;
}

export interface ComposerReseedTarget {
  setText(text: string): void;
  setRole(role: ThreadComposerState["role"]): void;
  setRunConfig(runConfig: ThreadComposerState["runConfig"]): void;
  setQuote(quote: ThreadComposerState["quote"]): void;
  addAttachment(attachment: CreateAttachment): Promise<void>;
}

export interface DraftSubmissionRef {
  current: Promise<void> | null;
}

type CompleteAttachmentFn = (attachment: PendingAttachment) => Promise<CompleteAttachment>;

/** 让首次 prompt 的 prepare/create/attach/send 共用同一个 in-flight Promise。 */
export function runDraftSubmissionSingleFlight(
  reference: DraftSubmissionRef,
  task: () => Promise<void>,
): Promise<void> {
  if (reference.current) return reference.current;
  const promise = task();
  reference.current = promise;
  void promise.then(
    () => {
      if (reference.current === promise) reference.current = null;
    },
    () => {
      if (reference.current === promise) reference.current = null;
    },
  );
  return promise;
}

/** 在创建 Pi session 前把 Composer 状态冻结成可发送、可恢复的载荷。 */
export async function prepareDraftSubmission(
  state: ThreadComposerState,
  completeAttachment: CompleteAttachmentFn = (attachment) => imageAttachmentAdapter.send(attachment),
): Promise<PreparedComposerSubmission> {
  if (!state.text.trim() && state.attachments.length === 0) throw new Error("请输入消息或添加图片");

  const attachments = await Promise.all(
    state.attachments.map((attachment) =>
      isCompleteAttachment(attachment) ? Promise.resolve(attachment) : completeAttachment(attachment),
    ),
  );
  const reseedAttachments = attachments.map<CreateAttachment>(({ id, type, name, contentType, content }) => ({
    id,
    type,
    name,
    ...(contentType !== undefined ? { contentType } : {}),
    content,
  }));
  return {
    message: {
      role: state.role,
      content: state.text ? [{ type: "text", text: state.text }] : [],
      attachments,
      runConfig: state.runConfig,
      metadata: { custom: state.quote ? { quote: state.quote } : {} },
    },
    reseed: {
      text: state.text,
      role: state.role,
      runConfig: state.runConfig,
      quote: state.quote,
      attachments: reseedAttachments,
    },
  };
}

function isCompleteAttachment(
  attachment: ThreadComposerState["attachments"][number],
): attachment is CompleteAttachment {
  return attachment.status.type === "complete";
}

/** 在 committed thread runtime 重建后恢复 readiness 阻止发送的首条输入。 */
export async function reseedComposer(composer: ComposerReseedTarget, reseed: ComposerReseed): Promise<void> {
  composer.setText(reseed.text);
  composer.setRole(reseed.role);
  composer.setRunConfig(reseed.runConfig);
  composer.setQuote(reseed.quote);
  for (const attachment of reseed.attachments) await composer.addAttachment(attachment);
}
