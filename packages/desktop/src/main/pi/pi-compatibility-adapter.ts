import { type AgentSession, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import type {
  ClearedQueue,
  PiQuote,
  SessionBranchInput,
  SessionBranchResult,
  SessionCommandResult,
  SessionEditInput,
  SessionPromptInput,
  SessionReloadInput,
} from "../../shared/contracts.ts";
import type { PiThreadProjector } from "./pi-thread-projector.ts";
import { type PiQuoteAttachmentData, QUOTE_ATTACHMENT_CUSTOM_TYPE, withQuoteContext } from "./quote-context.ts";

interface CompatibilityAdapterOptions {
  session: AgentSession;
  projector: PiThreadProjector;
}

/** 集中封装 Desktop 对 Pi public API 的全部调用。 */
export class PiCompatibilityAdapter {
  private readonly session: AgentSession;
  private readonly projector: PiThreadProjector;

  constructor(options: CompatibilityAdapterOptions) {
    assertCompatiblePi(options.session);
    this.session = options.session;
    this.projector = options.projector;
    // user entry 落盘后追加持久化引用附件，供会话重建时恢复结构化引用（UI 无需解析块引用文本）。
    this.projector.onUserEntryPersisted = (entryId, requestId, quotes) =>
      this.persistQuoteAttachment(entryId, requestId, quotes);
  }

  prompt(input: SessionPromptInput): Promise<SessionCommandResult> {
    return this.submit(input, true);
  }

  async edit(input: SessionEditInput): Promise<SessionCommandResult> {
    const entry = this.session.sessionManager.getEntry(input.sourceId);
    if (entry?.type !== "message" || entry.message.role !== "user")
      throw new Error(`Pi edit 目标不是 user entry: ${input.sourceId}`);
    return this.navigateAndSubmit(input.sourceId, input, true);
  }

  async reload(input: SessionReloadInput): Promise<SessionCommandResult> {
    if (!input.parentId) throw new Error("Pi reload 缺少前置 user entry");
    const entry = this.session.sessionManager.getEntry(input.parentId);
    if (entry?.type !== "message" || entry.message.role !== "user")
      throw new Error(`Pi reload 前置节点不是 user entry: ${input.parentId}`);
    const { text, images } = userInput(entry.message.content);
    return this.navigateAndSubmit(
      input.parentId,
      {
        requestId: input.requestId,
        projectId: input.projectId,
        threadId: input.threadId,
        text,
        images,
      },
      false,
    );
  }

  /** 在指定 entry 处创建新 session 文件并返回新会话 id + 文件路径。 */
  async branch(input: SessionBranchInput): Promise<SessionBranchResult> {
    const manager = this.session.sessionManager;
    if (!manager.isPersisted()) throw new Error("只能 fork 已持久化的 session");
    const sourceSessionFile = this.session.sessionFile;
    if (!sourceSessionFile) throw new Error("已持久化的 Pi session 缺少文件路径");
    const entry = manager.getEntry(input.sourceEntryId);
    if (!entry) throw new Error(`Pi branch 目标 entry 不存在: ${input.sourceEntryId}`);
    // createBranchedSession 会原地替换 manager identity；必须在独立 manager 上执行，保持 source worker 归属不变。
    const branchManager = SessionManager.open(sourceSessionFile, manager.getSessionDir(), manager.getCwd());
    const branchSessionFile = branchManager.createBranchedSession(input.sourceEntryId);
    if (!branchSessionFile) throw new Error("Pi createBranchedSession 未生成新 session 文件");
    const header = branchManager.getHeader();
    if (!header?.id) throw new Error(`Pi branch 新 session header 无效: ${branchSessionFile}`);
    return { branchThreadId: header.id, branchSessionFile };
  }

  /** 将结构化引用作为 session custom entry 持久化（custom 类型默认不进 LLM 上下文）。 */
  private persistQuoteAttachment(entryId: string, requestId: string, quotes: readonly PiQuote[]): void {
    const data: PiQuoteAttachmentData = { userEntryId: entryId, requestId, quotes: [...quotes] };
    this.session.sessionManager.appendCustomEntry(QUOTE_ATTACHMENT_CUSTOM_TYPE, data);
  }

  async cancel(): Promise<ClearedQueue> {
    const phase = this.projector.snapshot().phase;
    if (phase === "compacting") {
      this.session.abortCompaction();
      return { steering: [], followUp: [] };
    }
    if (phase === "tree-navigation") {
      this.session.abortBranchSummary();
      return { steering: [], followUp: [] };
    }
    if (phase === "running") {
      const cleared = this.clearQueue();
      await this.session.abort();
      return cleared;
    }
    if (phase === "retrying") {
      await this.session.abort();
      return { steering: [], followUp: [] };
    }
    throw new Error("Pi session 当前没有可取消操作");
  }

  clearQueue(): ClearedQueue {
    this.projector.beginQueueClear();
    try {
      return this.session.clearQueue();
    } finally {
      this.projector.endQueueClear();
    }
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }

  synchronizePersistedBranch(): void {
    this.projector.checkpoint();
    this.projector.flush();
  }

  private async navigateAndSubmit(
    targetId: string,
    input: SessionPromptInput,
    expandPromptTemplates: boolean,
  ): Promise<SessionCommandResult> {
    const oldLeaf = this.session.sessionManager.getLeafId();
    await this.navigate(targetId, "Pi extension 取消了 tree navigation", true);
    let result: SessionCommandResult;
    try {
      result = await this.submit(input, expandPromptTemplates);
    } catch (error) {
      if (oldLeaf && this.session.sessionManager.getEntry(oldLeaf)) {
        await this.navigate(oldLeaf, `Pi branch 恢复被取消: ${errorMessage(error)}`);
      }
      throw error;
    }
    if (!result.accepted && oldLeaf && this.session.sessionManager.getEntry(oldLeaf)) {
      await this.navigate(oldLeaf, `Pi branch 恢复被取消: ${result.error ?? "Pi 未接受输入"}`);
    }
    return result;
  }

  private async navigate(targetId: string, cancelledMessage: string, requireUserRewind = false): Promise<void> {
    this.projector.beginTreeNavigation();
    try {
      const navigation = await this.session.navigateTree(targetId, { summarize: false });
      if (navigation.cancelled) throw new Error(cancelledMessage);
      if (requireUserRewind && navigation.editorText === undefined)
        throw new Error(`Pi navigateTree 未回退 user entry: ${targetId}`);
    } finally {
      this.projector.endTreeNavigation();
    }
  }

  private async submit(input: SessionPromptInput, expandPromptTemplates: boolean): Promise<SessionCommandResult> {
    const queueEligible = this.session.isStreaming;
    if (queueEligible && input.text.trim().length === 0) throw new Error("Pi running queue 不接受仅包含图片的输入");
    if (input.quotes) {
      this.projector.beginPrompt(
        input.requestId,
        input.desiredMode,
        queueEligible,
        input.text,
        input.quote,
        input.quotes,
      );
    } else {
      this.projector.beginPrompt(input.requestId, input.desiredMode, queueEligible, input.text, input.quote);
    }
    return new Promise((resolve, reject) => {
      let preflight: boolean | undefined;
      const prompt = Promise.resolve(
        this.session.prompt(withQuoteContext(input.text, input.quotes ?? (input.quote ? [input.quote] : [])), {
          images: input.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
          expandPromptTemplates,
          source: expandPromptTemplates ? "interactive" : "extension",
          ...(queueEligible ? { streamingBehavior: input.desiredMode ?? "followUp" } : {}),
          preflightResult: (success) => {
            if (preflight !== undefined) return;
            preflight = success;
            this.projector.markPromptPreflight(input.requestId, success);
            if (success) {
              resolve({ accepted: true, queued: this.projector.hasQueuedRequest(input.requestId) });
            }
          },
        }),
      );
      void prompt
        .then(
          () => {
            if (preflight === undefined) {
              reject(new Error("Pi prompt resolved without preflight acceptance"));
            } else if (!preflight) {
              resolve({ accepted: false, queued: false });
            }
          },
          (error: unknown) => {
            if (preflight === undefined) reject(error);
            else if (!preflight) resolve({ accepted: false, queued: false, error: errorMessage(error) });
          },
        )
        .finally(() => this.projector.finishPrompt(input.requestId));
    });
  }
}

export class UnsupportedPiCodingAgentError extends Error {
  constructor(missing: readonly string[]) {
    super(`不兼容的 pi-coding-agent ${VERSION}: 缺少 ${missing.join(", ")}`);
    this.name = "UnsupportedPiCodingAgentError";
  }
}

function assertCompatiblePi(session: AgentSession): void {
  const required = [
    "prompt",
    "sendUserMessage",
    "abort",
    "clearQueue",
    "getSteeringMessages",
    "getFollowUpMessages",
    "navigateTree",
    "compact",
    "abortCompaction",
    "abortBranchSummary",
    "subscribe",
  ] as const;
  const missing: string[] = required.filter((key) => typeof session[key] !== "function");
  if (typeof session.isStreaming !== "boolean") missing.push("isStreaming");
  const manager = session.sessionManager as unknown;
  if (!manager || typeof manager !== "object") {
    missing.push("sessionManager");
  } else {
    const managerSurface = manager as Record<string, unknown>;
    for (const key of [
      "getLeafId",
      "getBranch",
      "getEntry",
      "getLabel",
      "getSessionDir",
      "getCwd",
      "getHeader",
      "isPersisted",
      "createBranchedSession",
      "appendCustomEntry",
    ] as const)
      if (typeof managerSurface[key] !== "function") missing.push(`sessionManager.${key}`);
  }
  if (missing.length > 0) throw new UnsupportedPiCodingAgentError(missing);
}

function userInput(content: Extract<AgentSession["messages"][number], { role: "user" }>["content"]): {
  text: string;
  images: Array<{ name: string; data: string; mimeType: string }>;
} {
  if (typeof content === "string") return { text: content, images: [] };
  return {
    text: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    images: content.flatMap((part, index) =>
      part.type === "image" ? [{ name: `image-${index + 1}`, data: part.data, mimeType: part.mimeType }] : [],
    ),
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
