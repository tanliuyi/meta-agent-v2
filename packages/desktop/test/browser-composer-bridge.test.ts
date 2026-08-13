import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeBrowserAnnotationRemoval,
  BROWSER_ANNOTATION_QUOTE_PREFIX,
  type BrowserAnnotationConsumedEvent,
  browserAnnotationMessageIdsByTab,
  emitBrowserAnnotationConsumed,
  emitBrowserAnnotationToComposer,
  failBrowserAnnotationRemoval,
  invalidateBrowserAnnotationQuotes,
  removeBrowserAnnotationFromComposer,
  subscribeBrowserAnnotationConsumed,
  subscribeBrowserAnnotationToComposer,
  updateBrowserAnnotationInComposer,
} from "../src/renderer/src/state/browser-composer-bridge.ts";

const payload = (targetKey: string, messageId: string, tabId = 1, creationPageUrl = "https://example.com/") => ({
  targetKey,
  tabId,
  creationPageUrl,
  text: `标注 ${messageId}`,
  messageId,
});

describe("browser annotation composer bridge", () => {
  it("在目标 composer 尚未挂载时暂存，并在订阅后消费", () => {
    const targetKey = "session:queued";
    const queued = payload(targetKey, "annotation-1");
    const handler = vi.fn();

    emitBrowserAnnotationToComposer(queued);
    expect(handler).not.toHaveBeenCalled();

    const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
    expect(handler).toHaveBeenCalledWith({ type: "add", payload: queued });

    unsubscribe();
  });

  it("不会把标注广播到其他 session", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationToComposer("session:other", handler);

    emitBrowserAnnotationToComposer(payload("session:target", "annotation-2"));
    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("composer 暂时卸载后重新挂载仍能收到标注", () => {
    const targetKey = "session:remount";
    const firstHandler = vi.fn();
    const unsubscribeFirst = subscribeBrowserAnnotationToComposer(targetKey, firstHandler);
    unsubscribeFirst();

    const queued = payload(targetKey, "annotation-3");
    emitBrowserAnnotationToComposer(queued);

    const secondHandler = vi.fn();
    const unsubscribeSecond = subscribeBrowserAnnotationToComposer(targetKey, secondHandler);
    expect(secondHandler).toHaveBeenCalledWith({ type: "add", payload: queued });

    unsubscribeSecond();
  });

  it("update/remove 事件按 messageId 同步且会话隔离", () => {
    const handler = vi.fn();
    const otherHandler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationToComposer("session:sync", handler);
    const unsubscribeOther = subscribeBrowserAnnotationToComposer("session:other", otherHandler);

    emitBrowserAnnotationToComposer(payload("session:sync", "annotation-4"));
    updateBrowserAnnotationInComposer("session:sync", "annotation-4", "新文本");
    removeBrowserAnnotationFromComposer("session:sync", "annotation-4");

    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { type: "add", payload: payload("session:sync", "annotation-4") },
      { type: "update", messageId: "annotation-4", text: "新文本" },
      { type: "remove", messageId: "annotation-4" },
    ]);
    expect(otherHandler).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribeOther();
  });

  it("update/remove 在 composer 未挂载时排队，重挂后按序消费", () => {
    const targetKey = "session:queued-sync";
    emitBrowserAnnotationToComposer(payload(targetKey, "annotation-5"));
    updateBrowserAnnotationInComposer(targetKey, "annotation-5", "新文本");
    removeBrowserAnnotationFromComposer(targetKey, "annotation-5");

    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { type: "add", payload: payload(targetKey, "annotation-5") },
      { type: "update", messageId: "annotation-5", text: "新文本" },
      { type: "remove", messageId: "annotation-5" },
    ]);

    unsubscribe();
  });

  it("browserAnnotationMessageIdsByTab 按 tab 返回已引用 messageId，remove 后清除", () => {
    const targetKey = "session:tabs";
    emitBrowserAnnotationToComposer(payload(targetKey, "annotation-6", 1, "https://example.com/a"));
    emitBrowserAnnotationToComposer(payload(targetKey, "annotation-7", 2, "https://example.com/b"));

    expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual(["annotation-6"]);
    expect(browserAnnotationMessageIdsByTab(targetKey, 2)).toEqual(["annotation-7"]);

    removeBrowserAnnotationFromComposer(targetKey, "annotation-6");
    expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual([]);
    expect(browserAnnotationMessageIdsByTab(targetKey, 2)).toEqual(["annotation-7"]);
  });

  describe("invalidateBrowserAnnotationQuotes 按创建时 URL 逐条失效", () => {
    it("同规范化 URL（https://example.com 与 https://example.com/）保留引用", () => {
      const targetKey = "session:invalidate-equal";
      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-eq", 1, "https://example.com/"));
      handler.mockClear();

      invalidateBrowserAnnotationQuotes(targetKey, 1, "https://example.com");

      expect(handler).not.toHaveBeenCalled();
      expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual(["annotation-eq"]);

      unsubscribe();
    });

    it("面板重挂（无 previousUrl 快照）时 current URL 不同仍清该 tab 引用，其他 tab 不受影响", () => {
      const targetKey = "session:invalidate-remount";
      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-old", 1, "https://example.com/old"));
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-other", 2, "https://example.com/old"));
      handler.mockClear();

      // 面板隐藏期间 Agent 后台导航到新页面；重挂后首次 URL 同步即失效。
      invalidateBrowserAnnotationQuotes(targetKey, 1, "https://example.com/new");

      expect(handler.mock.calls.map(([event]) => event)).toEqual([{ type: "remove", messageId: "annotation-old" }]);
      expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual([]);
      expect(browserAnnotationMessageIdsByTab(targetKey, 2)).toEqual(["annotation-other"]);

      unsubscribe();
    });

    it("同 tab 内逐条比较：当前 URL 上的引用保留，旧页面的移除", () => {
      const targetKey = "session:invalidate-mixed";
      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-a", 1, "https://example.com/a"));
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-b", 1, "https://example.com/b"));
      handler.mockClear();

      invalidateBrowserAnnotationQuotes(targetKey, 1, "https://example.com/b");

      expect(handler.mock.calls.map(([event]) => event)).toEqual([{ type: "remove", messageId: "annotation-a" }]);
      expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual(["annotation-b"]);

      unsubscribe();
    });

    it("about:blank/空 URL 过渡不失效，等真实 URL 到达", () => {
      const targetKey = "session:invalidate-blank";
      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-blank", 1, "https://example.com/a"));
      handler.mockClear();

      invalidateBrowserAnnotationQuotes(targetKey, 1, "");
      invalidateBrowserAnnotationQuotes(targetKey, 1, "about:blank");

      expect(handler).not.toHaveBeenCalled();
      expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual(["annotation-blank"]);

      unsubscribe();
    });

    it("失效移除后映射清除，消费后继续遗忘", () => {
      const targetKey = "session:invalidate-forget";
      const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, vi.fn());
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-f1", 1, "https://example.com/a"));
      emitBrowserAnnotationToComposer(payload(targetKey, "annotation-f2", 1, "https://example.com/b"));

      invalidateBrowserAnnotationQuotes(targetKey, 1, "https://example.com/b");
      expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual(["annotation-f2"]);

      emitBrowserAnnotationConsumed({ targetKey, messageIds: ["annotation-f2"] });
      expect(browserAnnotationMessageIdsByTab(targetKey, 1)).toEqual([]);

      unsubscribe();
    });
  });

  it("消费事件在面板未挂载时排队，订阅后送达且会话隔离", () => {
    const targetKey = "session:consume";
    const event = { targetKey, messageIds: ["annotation-8", "annotation-9"] };
    const otherHandler = vi.fn();
    const unsubscribeOther = subscribeBrowserAnnotationConsumed("session:other", otherHandler);

    emitBrowserAnnotationConsumed(event);
    expect(otherHandler).not.toHaveBeenCalled();

    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed(targetKey, handler);
    expect(handler).toHaveBeenCalledWith(event);
    expect(otherHandler).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribeOther();
  });

  it("面板卸载后消费事件重挂仍送达，且只送达目标 session", () => {
    const targetKey = "session:consume-remount";
    const firstHandler = vi.fn();
    const unsubscribeFirst = subscribeBrowserAnnotationConsumed(targetKey, firstHandler);
    unsubscribeFirst();

    const event = { targetKey, messageIds: ["annotation-10"] };
    emitBrowserAnnotationConsumed(event);

    const secondHandler = vi.fn();
    const unsubscribeSecond = subscribeBrowserAnnotationConsumed(targetKey, secondHandler);
    expect(secondHandler).toHaveBeenCalledWith(event);

    unsubscribeSecond();
  });

  describe("删除失败重试（fail/acknowledge 登记）", () => {
    it("删除失败登记后，下次消费事件合并重试；确认成功后不再重试", () => {
      const targetKey = "session:retry-merge";
      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationConsumed(targetKey, handler);

      emitBrowserAnnotationConsumed({ targetKey, messageIds: ["browser-annotation:a"] });
      expect(handler).toHaveBeenLastCalledWith({ targetKey, messageIds: ["browser-annotation:a"] });
      handler.mockClear();

      // 删除失败：登记待重试。
      failBrowserAnnotationRemoval(targetKey, ["browser-annotation:a"]);

      // 下次消费事件（新标注发送成功）合并旧失败项一并重试。
      emitBrowserAnnotationConsumed({ targetKey, messageIds: ["browser-annotation:b"] });
      expect(handler).toHaveBeenCalledWith({
        targetKey,
        messageIds: ["browser-annotation:a", "browser-annotation:b"],
      });
      handler.mockClear();

      // 本次删除成功：确认后不再出现在后续事件中。
      acknowledgeBrowserAnnotationRemoval(targetKey, ["browser-annotation:a", "browser-annotation:b"]);
      emitBrowserAnnotationConsumed({ targetKey, messageIds: ["browser-annotation:c"] });
      expect(handler).toHaveBeenLastCalledWith({ targetKey, messageIds: ["browser-annotation:c"] });

      unsubscribe();
    });

    it("面板重挂（重新订阅）时立即重试待删除项，且只送达目标 session", () => {
      const targetKey = "session:retry-remount";
      const firstHandler = vi.fn();
      const unsubscribeFirst = subscribeBrowserAnnotationConsumed(targetKey, firstHandler);
      unsubscribeFirst();

      // 重复登记幂等合并（同 messageId 只保留一次）。
      failBrowserAnnotationRemoval(targetKey, ["browser-annotation:old"]);
      failBrowserAnnotationRemoval(targetKey, ["browser-annotation:old"]);

      const otherHandler = vi.fn();
      const unsubscribeOther = subscribeBrowserAnnotationConsumed("session:retry-other", otherHandler);
      expect(otherHandler).not.toHaveBeenCalled();

      const secondHandler = vi.fn();
      const unsubscribeSecond = subscribeBrowserAnnotationConsumed(targetKey, secondHandler);
      expect(secondHandler).toHaveBeenCalledWith({ targetKey, messageIds: ["browser-annotation:old"] });

      unsubscribeSecond();
      unsubscribeOther();
    });

    it("面板边界：fail/ack 登记与重试事件均为完整 messageId，剥离前缀后是有效 annotation id", () => {
      const targetKey = "session:retry-panel-boundary";
      const firstHandler = vi.fn();
      const unsubscribeFirst = subscribeBrowserAnnotationConsumed(targetKey, firstHandler);
      unsubscribeFirst();

      // 面板删除 IPC 失败后登记：必须使用完整 messageId（与事件同单位）。
      failBrowserAnnotationRemoval(targetKey, ["browser-annotation:a"]);

      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationConsumed(targetKey, handler);
      const event = handler.mock.calls[0]?.[0] as BrowserAnnotationConsumedEvent;
      expect(event.messageIds).toEqual(["browser-annotation:a"]);
      // 模拟面板边界：重试事件剥离前缀后得到裸 annotation id，不得出现空串。
      const annotationIds = event.messageIds.map((messageId) =>
        messageId.slice(BROWSER_ANNOTATION_QUOTE_PREFIX.length),
      );
      expect(annotationIds).toEqual(["a"]);
      expect(annotationIds.every((id) => id.length > 0)).toBe(true);

      // 删除成功：ack 同样用完整 messageId 移除，后续重挂不再重试。
      acknowledgeBrowserAnnotationRemoval(targetKey, ["browser-annotation:a"]);
      unsubscribe();

      const afterHandler = vi.fn();
      const unsubscribeAfter = subscribeBrowserAnnotationConsumed(targetKey, afterHandler);
      expect(afterHandler).not.toHaveBeenCalled();
      unsubscribeAfter();
    });

    it("fail 登记超过 64 项时全部保留（失败项是不可丢弃的持久工作，不做截断）", () => {
      const targetKey = "session:retry-cap";
      const many = Array.from({ length: 70 }, (_, i) => `browser-annotation:r-${i}`);
      failBrowserAnnotationRemoval(targetKey, many.slice(0, 40));
      failBrowserAnnotationRemoval(targetKey, many.slice(40));

      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationConsumed(targetKey, handler);
      const event = handler.mock.calls[0]?.[0] as BrowserAnnotationConsumedEvent;
      expect(event.messageIds).toHaveLength(70);
      expect(event.messageIds[0]).toBe("browser-annotation:r-0");
      expect(event.messageIds.at(-1)).toBe("browser-annotation:r-69");

      unsubscribe();
    });

    it("acknowledge 只移除已确认项，其余保留待重试；空列表安全", () => {
      const targetKey = "session:retry-partial";
      const handler = vi.fn();
      const unsubscribe = subscribeBrowserAnnotationConsumed(targetKey, handler);

      failBrowserAnnotationRemoval(targetKey, ["browser-annotation:x", "browser-annotation:y"]);
      acknowledgeBrowserAnnotationRemoval(targetKey, ["browser-annotation:x", "missing"]);
      emitBrowserAnnotationConsumed({ targetKey, messageIds: ["browser-annotation:z"] });
      expect(handler).toHaveBeenLastCalledWith({
        targetKey,
        messageIds: ["browser-annotation:y", "browser-annotation:z"],
      });

      unsubscribe();
    });
  });
});
