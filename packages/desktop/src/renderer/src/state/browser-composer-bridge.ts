import { sameBrowserUrl } from "../../../shared/browser-contracts.ts";
import type { PiQuote } from "../../../shared/contracts.ts";

/**
 * 浏览器标注 ↔ composer 引用桥（跨面板通信，会话定向）。
 *
 * 浏览器面板与 composer 属于同一个 renderer，但任一方都可能暂时未挂载：
 * - 面板 → composer：标注 add/update/remove 生命周期事件（quote 同步）。
 * - composer → 面板：composer.send 成功后的消费事件（由面板执行 main 批量删除）。
 * 事件一律按 session（targetKey）定向并暂存待消费，避免一次性广播丢失用户输入。
 */

/** composer 引用 messageId 前缀（标注 id 会话内全局唯一）。 */
export const BROWSER_ANNOTATION_QUOTE_PREFIX = "browser-annotation:";

/** 标注引用 messageId；与 add 事件生成的引用一一对应。 */
export function browserAnnotationMessageId(annotationId: string): string {
  return `${BROWSER_ANNOTATION_QUOTE_PREFIX}${annotationId}`;
}

/** 面板 → composer 的标注事件载荷（含标注所在 tab 与创建时页面 URL，供页面切换失效同步定位）。 */
export interface BrowserAnnotationComposerPayload extends PiQuote {
  /** 接收标注的 session record key。 */
  targetKey: string;
  /** 标注所在 tab；面板按 (session, tab) 定位已引用标注。 */
  tabId: number;
  /** 标注创建时的页面 URL（面板保存时如实登记，不从展示 tags 解析）；失效同步按它逐条比较。 */
  creationPageUrl: string;
}

export type BrowserAnnotationComposerEvent =
  | { type: "add"; payload: BrowserAnnotationComposerPayload }
  | { type: "update"; messageId: string; text: string }
  | { type: "remove"; messageId: string };

/** composer → 面板：本次 prompt 成功发送后已消费的标注引用 messageId 列表。 */
export interface BrowserAnnotationConsumedEvent {
  targetKey: string;
  messageIds: string[];
}

type AnnotationComposerHandler = (event: BrowserAnnotationComposerEvent) => void;
type ConsumedHandler = (event: BrowserAnnotationConsumedEvent) => void;

const composerHandlers = new Map<string, Set<AnnotationComposerHandler>>();
const consumedHandlers = new Map<string, Set<ConsumedHandler>>();
const pendingByTarget = new Map<string, BrowserAnnotationComposerEvent[]>();
const pendingConsumedByTarget = new Map<string, BrowserAnnotationConsumedEvent[]>();
/** sessionKey -> (messageId -> 标注位置)：面板已注入 composer 的标注引用定位表（tab + 创建时 URL）。 */
const quotedLocationByMessageId = new Map<string, Map<string, { tabId: number; creationPageUrl: string }>>();
/** sessionKey -> 删除失败待重试的标注引用 messageId 列表（完整前缀 messageId，非裸 annotation id；
 *  下次消费事件或面板重挂时合并重试）。 */
const pendingRemovalByTarget = new Map<string, string[]>();
const MAX_PENDING_PER_TARGET = 64;

function rememberQuote(targetKey: string, messageId: string, tabId: number, creationPageUrl: string): void {
  let byMessageId = quotedLocationByMessageId.get(targetKey);
  if (!byMessageId) {
    byMessageId = new Map();
    quotedLocationByMessageId.set(targetKey, byMessageId);
  }
  byMessageId.set(messageId, { tabId, creationPageUrl });
}

function forgetQuote(targetKey: string, messageId: string): void {
  const byMessageId = quotedLocationByMessageId.get(targetKey);
  if (!byMessageId) return;
  byMessageId.delete(messageId);
  if (byMessageId.size === 0) quotedLocationByMessageId.delete(targetKey);
}

/** 会话内已注入 composer 的标注引用 messageId（按 tab 过滤；URL 失效同步用）。 */
export function browserAnnotationMessageIdsByTab(targetKey: string, tabId: number): string[] {
  const byMessageId = quotedLocationByMessageId.get(targetKey);
  if (!byMessageId) return [];
  const ids: string[] = [];
  for (const [messageId, location] of byMessageId) {
    if (location.tabId === tabId) ids.push(messageId);
  }
  return ids;
}

/**
 * 以标注创建时登记的页面 URL 与 tab 当前 URL 逐条比较（规范化比较，与 main 标注
 * 失效同一语义），移除已离开页面的 composer 引用。面板重挂后无 previousUrl 快照
 * 也能识别隐藏期间的后台导航：URL 相同保留，真正不同移除。about:blank/空 URL 是
 * attach/navigate 过渡态，跳过等待真实 URL，避免误删。
 */
export function invalidateBrowserAnnotationQuotes(targetKey: string, tabId: number, currentUrl: string): void {
  if (currentUrl.length === 0 || currentUrl === "about:blank") return;
  const byMessageId = quotedLocationByMessageId.get(targetKey);
  if (!byMessageId) return;
  const stale: string[] = [];
  for (const [messageId, location] of byMessageId) {
    if (location.tabId !== tabId) continue;
    if (!sameBrowserUrl(location.creationPageUrl, currentUrl)) stale.push(messageId);
  }
  for (const messageId of stale) removeBrowserAnnotationFromComposer(targetKey, messageId);
}

function dispatchToComposer(
  event: BrowserAnnotationComposerEvent,
  targetHandlers: Set<AnnotationComposerHandler>,
): void {
  for (const handler of [...targetHandlers]) {
    try {
      handler(event);
    } catch {
      // 单个订阅者异常不影响其余。
    }
  }
}

/** 广播一条新标注到目标 session 的 composer；目标暂不可用时先排队。 */
export function emitBrowserAnnotationToComposer(payload: BrowserAnnotationComposerPayload): void {
  rememberQuote(payload.targetKey, payload.messageId, payload.tabId, payload.creationPageUrl);
  const event: BrowserAnnotationComposerEvent = { type: "add", payload };
  const targetHandlers = composerHandlers.get(payload.targetKey);
  if (!targetHandlers || targetHandlers.size === 0) {
    enqueuePending(pendingByTarget, payload.targetKey, event);
    return;
  }
  dispatchToComposer(event, targetHandlers);
}

/** 标注文本更新：原位同步 composer 中同 messageId 的引用文本。 */
export function updateBrowserAnnotationInComposer(targetKey: string, messageId: string, text: string): void {
  const event: BrowserAnnotationComposerEvent = { type: "update", messageId, text };
  const targetHandlers = composerHandlers.get(targetKey);
  if (!targetHandlers || targetHandlers.size === 0) {
    enqueuePending(pendingByTarget, targetKey, event);
    return;
  }
  dispatchToComposer(event, targetHandlers);
}

/** 标注删除/页面切换失效：从 composer 移除同 messageId 的引用。 */
export function removeBrowserAnnotationFromComposer(targetKey: string, messageId: string): void {
  forgetQuote(targetKey, messageId);
  const event: BrowserAnnotationComposerEvent = { type: "remove", messageId };
  const targetHandlers = composerHandlers.get(targetKey);
  if (!targetHandlers || targetHandlers.size === 0) {
    enqueuePending(pendingByTarget, targetKey, event);
    return;
  }
  dispatchToComposer(event, targetHandlers);
}

/** 订阅目标 session 的标注生命周期事件，并消费该 session 已排队的事件。 */
export function subscribeBrowserAnnotationToComposer(
  targetKey: string,
  handler: AnnotationComposerHandler,
): () => void {
  let targetHandlers = composerHandlers.get(targetKey);
  if (!targetHandlers) {
    targetHandlers = new Set<AnnotationComposerHandler>();
    composerHandlers.set(targetKey, targetHandlers);
  }
  targetHandlers.add(handler);

  const pending = pendingByTarget.get(targetKey);
  if (pending && pending.length > 0) {
    pendingByTarget.delete(targetKey);
    for (const event of pending) dispatchToComposer(event, targetHandlers);
  }

  return () => {
    targetHandlers.delete(handler);
    if (targetHandlers.size === 0 && composerHandlers.get(targetKey) === targetHandlers) {
      composerHandlers.delete(targetKey);
    }
  };
}

/** composer 成功发送后广播已消费的标注引用；面板暂不可用时先排队。 */
export function emitBrowserAnnotationConsumed(event: BrowserAnnotationConsumedEvent): void {
  // 消费后映射不再需要（引用已随 prompt 发送离开 composer），防止按 tab 定位泄漏。
  for (const messageId of event.messageIds) forgetQuote(event.targetKey, messageId);
  // 合并此前删除失败待重试的引用：面板在本次删除中一并重试（成功后才彻底确认）。
  const pendingRemoval = pendingRemovalByTarget.get(event.targetKey);
  const messageIds =
    pendingRemoval && pendingRemoval.length > 0
      ? [...new Set([...pendingRemoval, ...event.messageIds])]
      : event.messageIds;
  pendingRemovalByTarget.delete(event.targetKey);
  const mergedEvent: BrowserAnnotationConsumedEvent = { ...event, messageIds };
  const targetHandlers = consumedHandlers.get(event.targetKey);
  if (!targetHandlers || targetHandlers.size === 0) {
    enqueuePending(pendingConsumedByTarget, event.targetKey, mergedEvent);
    return;
  }
  for (const handler of [...targetHandlers]) {
    try {
      handler(mergedEvent);
    } catch {
      // 单个订阅者异常不影响其余。
    }
  }
}

/**
 * 删除失败登记：保留 main 侧标注与 overlay，等待下次消费事件或面板重挂时合并重试。
 * messageIds 必须与消费事件一致使用完整 messageId（前缀 + annotation id）：重试事件
 * 会原样交回面板，由面板负责剥离前缀后调用 IPC；登记裸 id 会导致重试时 slice 出空串。
 * 失败项是尚未完成的持久工作（main 侧标注仍在，annotationsByTab 无数量上限），
 * 不得像通知事件那样截断丢弃；只做幂等去重，保证全部失败项都能被重试。
 */
export function failBrowserAnnotationRemoval(targetKey: string, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const existing = pendingRemovalByTarget.get(targetKey) ?? [];
  pendingRemovalByTarget.set(targetKey, [...new Set([...existing, ...messageIds])]);
}

/** 删除成功确认：从待重试集合移除（幂等；不存在的项忽略）。messageIds 同为完整 messageId。 */
export function acknowledgeBrowserAnnotationRemoval(targetKey: string, messageIds: string[]): void {
  const existing = pendingRemovalByTarget.get(targetKey);
  if (!existing) return;
  const remaining = existing.filter((messageId) => !messageIds.includes(messageId));
  if (remaining.length === 0) pendingRemovalByTarget.delete(targetKey);
  else pendingRemovalByTarget.set(targetKey, remaining);
}

/** 订阅目标 session 的标注消费事件，并消费已排队事件。 */
export function subscribeBrowserAnnotationConsumed(targetKey: string, handler: ConsumedHandler): () => void {
  let targetHandlers = consumedHandlers.get(targetKey);
  if (!targetHandlers) {
    targetHandlers = new Set<ConsumedHandler>();
    consumedHandlers.set(targetKey, targetHandlers);
  }
  targetHandlers.add(handler);

  const pending = pendingConsumedByTarget.get(targetKey);
  if (pending && pending.length > 0) {
    pendingConsumedByTarget.delete(targetKey);
    for (const event of pending) {
      for (const pendingHandler of [...targetHandlers]) {
        try {
          pendingHandler(event);
        } catch {
          // 单个订阅者异常不影响其余。
        }
      }
    }
  }

  // 面板重挂：重试此前删除失败的标注引用（仅这一次；再次失败由面板重新登记）。
  const pendingRemoval = pendingRemovalByTarget.get(targetKey);
  if (pendingRemoval && pendingRemoval.length > 0) {
    pendingRemovalByTarget.delete(targetKey);
    for (const pendingHandler of [...targetHandlers]) {
      try {
        pendingHandler({ targetKey, messageIds: pendingRemoval });
      } catch {
        // 单个订阅者异常不影响其余。
      }
    }
  }

  return () => {
    targetHandlers.delete(handler);
    if (targetHandlers.size === 0 && consumedHandlers.get(targetKey) === targetHandlers) {
      consumedHandlers.delete(targetKey);
    }
  };
}

function enqueuePending<T>(queue: Map<string, T[]>, targetKey: string, event: T): void {
  const pending = queue.get(targetKey) ?? [];
  pending.push(event);
  if (pending.length > MAX_PENDING_PER_TARGET) pending.splice(0, pending.length - MAX_PENDING_PER_TARGET);
  queue.set(targetKey, pending);
}

/** 会话退役时释放桥接订阅、待投递事件、引用定位和失败重试。 */
export function retireBrowserComposerBridge(targetKey: string): void {
  composerHandlers.delete(targetKey);
  consumedHandlers.delete(targetKey);
  pendingByTarget.delete(targetKey);
  pendingConsumedByTarget.delete(targetKey);
  quotedLocationByMessageId.delete(targetKey);
  pendingRemovalByTarget.delete(targetKey);
}

/**
 * 浏览器标注引用提交追踪器：发送前快照 composer 中的标注引用，send 成功后
 * 广播消费。draft/session 所有真正 send 入口（Enter、命令、表单提交）都在
 * 触发发送前调用 snapshot；onSend 只消费最近一次快照，避免重复/陈旧。
 */
export class BrowserAnnotationSubmitTracker {
  private pending: string[] = [];
  private readonly targetKey: string;

  constructor(targetKey: string) {
    this.targetKey = targetKey;
  }

  /** 发送前快照当前 composer 中的标注引用 messageId（只保留浏览器标注前缀）。 */
  snapshot(quotes: readonly PiQuote[]): void {
    this.pending = quotes
      .map((quote) => quote.messageId)
      .filter((messageId) => messageId.startsWith(BROWSER_ANNOTATION_QUOTE_PREFIX));
  }

  /** send 成功后广播本次快照的消费事件并清空；无快照时静默。 */
  onSend(): void {
    if (this.pending.length === 0) return;
    const messageIds = this.pending;
    this.pending = [];
    emitBrowserAnnotationConsumed({ targetKey: this.targetKey, messageIds });
  }
}
