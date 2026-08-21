import type { AppendMessage, CreateAttachment, QuoteInfo } from "@assistant-ui/react";
import type {
  PiQueueItem,
  PiQuote,
  PiThreadPhase,
  SessionCommandResult,
  SessionPromptInput,
} from "../../../shared/contracts.ts";
import { getComposerQuotes, getMessageQuotes, parseQuoteValue, toComposerQuote } from "./composer-quotes.ts";
import { toComposerAttachmentInput, toPiImageInputs } from "./image-attachments.ts";

interface SessionTarget {
  projectId: string;
  threadId: string;
  generation: number;
}

interface ComposerTarget {
  getState(): { text: string; quote?: QuoteInfo };
  setText(text: string): void;
  setQuote?(quote: QuoteInfo | undefined): void;
  addAttachment(attachment: File | CreateAttachment): Promise<void>;
}

interface CoordinatorOptions {
  getTarget(): SessionTarget | null;
  getComposer(): ComposerTarget | null;
  getPhase(): PiThreadPhase;
  report(error: unknown): void;
}

interface PendingInput {
  message: AppendMessage;
  queued: boolean;
}

/** 将 assistant-ui callbacks 收敛为 typed Pi commands。 */
export class PiCommandCoordinator {
  private readonly getTarget: CoordinatorOptions["getTarget"];
  private readonly getComposer: CoordinatorOptions["getComposer"];
  private readonly getPhase: CoordinatorOptions["getPhase"];
  private readonly report: CoordinatorOptions["report"];
  private readonly pendingInputs = new Map<string, PendingInput>();

  constructor(options: CoordinatorOptions) {
    this.getTarget = options.getTarget;
    this.getComposer = options.getComposer;
    this.getPhase = options.getPhase;
    this.report = options.report;
  }

  enqueue = (message: AppendMessage): void => {
    this.submitPending(message, "followUp");
  };

  steer = (message: AppendMessage): void => {
    this.submitPending(message, "steer");
  };

  private submitPending(message: AppendMessage, desiredMode: "steer" | "followUp"): void {
    const target = this.requireTarget();
    const requestId = crypto.randomUUID();
    this.rememberInput(requestId, message);
    void this.submit(message, target, desiredMode, requestId).then(
      (result) => {
        const pending = this.pendingInputs.get(requestId);
        if (!pending) return;
        if (result.queued) pending.queued = true;
        else this.forgetInput(requestId);
      },
      async (error: unknown) => {
        this.forgetInput(requestId);
        if (this.isCurrent(target)) await this.reseed(message);
        this.report(error);
      },
    );
  }

  cancel = async (): Promise<void> => {
    const target = this.requireTarget();
    this.pendingInputs.clear();
    await window.desktop.sessions.cancel(target.projectId, target.threadId);
  };

  rejectUnexpectedOnNew = async (): Promise<void> => {
    throw new Error("assistant-ui queue routing 已改变：配置 queue 后不应调用 onNew");
  };

  observeQueue(items: readonly PiQueueItem[]): void {
    const queuedRequestIds = new Set(items.flatMap((item) => (item.requestId ? [item.requestId] : [])));
    for (const [requestId, pending] of this.pendingInputs) {
      if (queuedRequestIds.has(requestId)) pending.queued = true;
      else if (pending.queued) this.pendingInputs.delete(requestId);
    }
  }

  unsupportedQueueOperation = (): never => {
    throw new Error("Pi public queue API 不支持单项 move/edit/remove");
  };

  private async submit(
    message: AppendMessage,
    target: SessionTarget,
    desiredMode: "steer" | "followUp",
    requestId: string,
  ): Promise<SessionCommandResult> {
    const phase = this.getPhase();
    if (phase !== "idle" && phase !== "running") throw new Error(`Pi ${phase} 阶段不接受 Composer submit`);
    if (phase === "running" && messageText(message).trim().length === 0)
      throw new Error("Pi running queue 不接受仅包含图片的输入");
    const input = await promptInput(message, target, desiredMode, requestId);
    const result = await window.desktop.sessions.prompt(input);
    assertAccepted(result);
    if (result.error) this.report(result.error);
    return result;
  }

  private requireTarget(): SessionTarget {
    const target = this.getTarget();
    if (!target) throw new Error("Pi runtime 尚未 attach session");
    return target;
  }

  private isCurrent(target: SessionTarget): boolean {
    const current = this.getTarget();
    return (
      current?.projectId === target.projectId &&
      current.threadId === target.threadId &&
      current.generation === target.generation
    );
  }

  private async reseed(message: AppendMessage): Promise<void> {
    const composer = this.getComposer();
    if (!composer || message.role !== "user") return;
    composer.setText(messageText(message));
    restoreComposerQuotes(composer, getMessageQuotes(message.metadata?.custom));
    for (const attachment of message.attachments ?? []) {
      await composer.addAttachment(toComposerAttachmentInput(attachment));
    }
  }

  private rememberInput(requestId: string, message: AppendMessage): void {
    this.pendingInputs.set(requestId, { message, queued: false });
  }

  private forgetInput(requestId: string): void {
    this.pendingInputs.delete(requestId);
  }
}

function assertAccepted(result: SessionCommandResult): void {
  if (!result.accepted) throw new Error(result.error ?? "Pi 未接受此输入");
}

async function promptInput(
  message: AppendMessage,
  target: SessionTarget,
  desiredMode: "steer" | "followUp" | undefined,
  requestId: string = crypto.randomUUID(),
): Promise<SessionPromptInput> {
  if (message.role !== "user") throw new Error(`Pi Composer 只接受 user message: ${message.role}`);
  const messageQuotes = quotes(message);
  const messageQuote = messageQuotes.length === 1 ? messageQuotes[0] : undefined;
  return {
    requestId,
    projectId: target.projectId,
    threadId: target.threadId,
    text: messageText(message),
    images: await toPiImageInputs(message.attachments ?? []),
    ...(messageQuote ? { quote: messageQuote } : {}),
    ...(messageQuotes.length > 1 ? { quotes: messageQuotes } : {}),
    ...(desiredMode ? { desiredMode } : {}),
  };
}

function messageText(message: AppendMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function quotes(message: AppendMessage): PiQuote[] {
  const custom = message.metadata?.custom;
  if (!custom || typeof custom !== "object") return [];
  const value = "quotes" in custom ? custom.quotes : "quote" in custom ? custom.quote : undefined;
  return parseQuoteValue(value);
}

function restoreComposerQuotes(composer: ComposerTarget, quotes: readonly QuoteInfo[]): void {
  if (!composer.setQuote || quotes.length === 0) return;
  const current = getComposerQuotes(composer.getState().quote);
  composer.setQuote(toComposerQuote([...current, ...quotes]));
}
