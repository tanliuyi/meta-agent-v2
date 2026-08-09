import type { AppendMessage, CreateAttachment, QuoteInfo } from "@assistant-ui/react";
import type {
  ClearedQueue,
  PiQueueItem,
  PiQuote,
  PiThreadPhase,
  PiThreadSnapshot,
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

interface CommandNotification {
  title: string;
  message: string;
  tone: "info" | "success" | "error";
  duration?: number;
}

interface CoordinatorOptions {
  getTarget(): SessionTarget | null;
  getComposer(): ComposerTarget | null;
  getPhase(): PiThreadPhase;
  resolveReloadTarget(parentId: string | null): string | null;
  notify(notification: CommandNotification): string;
  updateNotification(id: string, notification: CommandNotification): void;
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
  private readonly resolveReloadTarget: CoordinatorOptions["resolveReloadTarget"];
  private readonly notify: CoordinatorOptions["notify"];
  private readonly updateNotification: CoordinatorOptions["updateNotification"];
  private readonly report: CoordinatorOptions["report"];
  private readonly pendingInputs = new Map<string, PendingInput>();

  constructor(options: CoordinatorOptions) {
    this.getTarget = options.getTarget;
    this.getComposer = options.getComposer;
    this.getPhase = options.getPhase;
    this.resolveReloadTarget = options.resolveReloadTarget;
    this.notify = options.notify;
    this.updateNotification = options.updateNotification;
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

  edit = async (
    message: AppendMessage,
    items: readonly PiQueueItem[] = [],
    isRunning = this.getPhase() === "running",
  ): Promise<void> => {
    if (isRunning) await this.cancel(items);
    else this.assertIdle("edit");
    const target = this.requireTarget();
    if (!message.sourceId) throw new Error("assistant-ui edit 缺少 sourceId");
    const input = await promptInput(message, target, undefined);
    const result = await window.desktop.sessions.edit({ ...input, sourceId: message.sourceId });
    assertAccepted(result);
    if (result.error) this.report(result.error);
  };

  reload = async (parentId: string | null): Promise<void> => {
    this.assertIdle("reload");
    const target = this.requireTarget();
    const userEntryId = this.resolveReloadTarget(parentId);
    if (!userEntryId) throw new Error("Pi reload 无法解析前置 user entry");
    const result = await window.desktop.sessions.reload({
      requestId: crypto.randomUUID(),
      projectId: target.projectId,
      threadId: target.threadId,
      parentId: userEntryId,
    });
    assertAccepted(result);
    if (result.error) this.report(result.error);
  };

  cancel = async (items: readonly PiQueueItem[]): Promise<void> => {
    const target = this.requireTarget();
    const pendingInputs = new Map(this.pendingInputs);
    const cleared = await window.desktop.sessions.cancel(target.projectId, target.threadId);
    await this.restoreClearedQueue(target, items, cleared, pendingInputs);
  };

  clearQueue = async (items: readonly PiQueueItem[]): Promise<void> => {
    const target = this.requireTarget();
    const pendingInputs = new Map(this.pendingInputs);
    const cleared = await window.desktop.sessions.clearQueue(target.projectId, target.threadId);
    await this.restoreClearedQueue(target, items, cleared, pendingInputs);
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
    const isResourceReload = input.text.trim() === "/reload" && input.images.length === 0;
    const progressNotificationId = isResourceReload
      ? this.notify({
          title: "正在重新加载",
          message: "正在重新加载扩展、技能、提示词和上下文文件",
          tone: "info",
          duration: 60_000,
        })
      : undefined;
    try {
      const result = isResourceReload
        ? await window.desktop.sessions.reloadResources({
            requestId: input.requestId,
            projectId: input.projectId,
            threadId: input.threadId,
          })
        : await window.desktop.sessions.prompt(input);
      assertAccepted(result);
      if (progressNotificationId) {
        this.updateNotification(
          progressNotificationId,
          result.error
            ? {
                title: "重新加载失败",
                message: result.error,
                tone: "error",
                duration: 5_000,
              }
            : {
                title: "重新加载完成",
                message: "当前会话已使用最新扩展和资源",
                tone: "success",
                duration: 5_000,
              },
        );
      }
      if (result.error) this.report(result.error);
      return result;
    } catch (error) {
      if (progressNotificationId) {
        this.updateNotification(progressNotificationId, {
          title: "重新加载失败",
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
          duration: 5_000,
        });
      }
      throw error;
    }
  }

  private async restoreClearedQueue(
    target: SessionTarget,
    items: readonly PiQueueItem[],
    cleared: ClearedQueue,
    pendingInputs: ReadonlyMap<string, PendingInput>,
  ): Promise<void> {
    const restored = matchClearedInputs(items, cleared.steering, cleared.followUp, pendingInputs);
    for (const { item } of restored) if (item.requestId) this.forgetInput(item.requestId);
    if (!this.isCurrent(target)) return;
    const composer = this.getComposer();
    if (!composer) return;
    const texts = [
      ...restored.map(({ prompt, message }) => (message ? messageText(message) : prompt)),
      composer.getState().text,
    ];
    composer.setText(texts.filter((value) => value.trim()).join("\n\n"));
    restoreComposerQuotes(
      composer,
      restored.flatMap(({ message }) => (message ? getMessageQuotes(message.metadata?.custom) : [])),
    );
    for (const { message } of restored) {
      if (!message) continue;
      for (const attachment of message.attachments ?? []) {
        await composer.addAttachment(toComposerAttachmentInput(attachment));
      }
    }
  }

  private requireTarget(): SessionTarget {
    const target = this.getTarget();
    if (!target) throw new Error("Pi runtime 尚未 attach session");
    return target;
  }

  private assertIdle(operation: string): void {
    const phase = this.getPhase();
    if (phase !== "idle") throw new Error(`Pi ${phase} 阶段不支持 ${operation}`);
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

export function resolveReloadUserEntry(snapshot: PiThreadSnapshot, parentId: string | null): string | null {
  let currentId = parentId;
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  while (currentId) {
    const node = byId.get(currentId);
    if (!node) return null;
    if (node.kind === "user") return node.sourceEntryId ?? null;
    currentId = node.parentId;
  }
  return null;
}

function matchClearedInputs(
  items: readonly PiQueueItem[],
  steering: readonly string[],
  followUp: readonly string[],
  pendingInputs: ReadonlyMap<string, PendingInput>,
): Array<{ item: PiQueueItem; prompt: string; message?: AppendMessage }> {
  const remaining = [...items];
  const result: Array<{ item: PiQueueItem; prompt: string; message?: AppendMessage }> = [];
  const append = (prompts: readonly string[], mode: PiQueueItem["mode"]) => {
    for (const prompt of prompts) {
      const index = remaining.findIndex((item) => item.mode === mode && item.prompt === prompt);
      const item = index === -1 ? undefined : remaining.splice(index, 1)[0];
      const fallback: PiQueueItem = item ?? {
        id: `cleared:${mode}:${result.length}`,
        mode,
        prompt,
        source: "pi-observed",
      };
      const message = fallback.requestId ? pendingInputs.get(fallback.requestId)?.message : undefined;
      result.push({ item: fallback, prompt, ...(message ? { message } : {}) });
    }
  };
  append(steering, "steer");
  append(followUp, "followUp");
  return result;
}
