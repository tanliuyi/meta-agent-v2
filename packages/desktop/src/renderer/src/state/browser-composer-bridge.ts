import type { PiQuote } from "../../../shared/contracts.ts";

/**
 * 浏览器标注 → composer 引用桥（跨面板通信）。
 *
 * 浏览器面板和 composer 属于同一个 renderer，但面板可能在 composer 尚未
 * 挂载或暂时不可用时保存标注。因此这里按 session 定向，并暂存待消费的
 * 标注，避免一次性的事件广播丢失用户输入。
 */
export interface BrowserAnnotationComposerPayload extends PiQuote {
  /** 接收标注的 session record key。 */
  targetKey: string;
}

type AnnotationComposerHandler = (payload: BrowserAnnotationComposerPayload) => void;

const handlers = new Map<string, Set<AnnotationComposerHandler>>();
const pendingByTarget = new Map<string, BrowserAnnotationComposerPayload[]>();
const MAX_PENDING_PER_TARGET = 64;

/** 广播一条标注到目标 session 的 composer；目标暂不可用时先排队。 */
export function emitBrowserAnnotationToComposer(payload: BrowserAnnotationComposerPayload): void {
  const targetHandlers = handlers.get(payload.targetKey);
  if (!targetHandlers || targetHandlers.size === 0) {
    const pending = pendingByTarget.get(payload.targetKey) ?? [];
    pending.push(payload);
    if (pending.length > MAX_PENDING_PER_TARGET) pending.splice(0, pending.length - MAX_PENDING_PER_TARGET);
    pendingByTarget.set(payload.targetKey, pending);
    return;
  }
  dispatch(payload, targetHandlers);
}

/** 订阅目标 session 的标注广播，并消费该 session 已排队的标注。 */
export function subscribeBrowserAnnotationToComposer(
  targetKey: string,
  handler: AnnotationComposerHandler,
): () => void {
  let targetHandlers = handlers.get(targetKey);
  if (!targetHandlers) {
    targetHandlers = new Set<AnnotationComposerHandler>();
    handlers.set(targetKey, targetHandlers);
  }
  targetHandlers.add(handler);

  const pending = pendingByTarget.get(targetKey);
  if (pending && pending.length > 0) {
    pendingByTarget.delete(targetKey);
    for (const payload of pending) dispatch(payload, targetHandlers);
  }

  return () => {
    targetHandlers.delete(handler);
    if (targetHandlers.size === 0 && handlers.get(targetKey) === targetHandlers) handlers.delete(targetKey);
  };
}

function dispatch(payload: BrowserAnnotationComposerPayload, targetHandlers: Set<AnnotationComposerHandler>): void {
  for (const handler of [...targetHandlers]) {
    try {
      handler(payload);
    } catch {
      // 单个订阅者异常不影响其余。
    }
  }
}
