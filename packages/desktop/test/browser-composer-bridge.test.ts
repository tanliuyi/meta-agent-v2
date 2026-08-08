import { describe, expect, it, vi } from "vitest";
import {
  emitBrowserAnnotationToComposer,
  subscribeBrowserAnnotationToComposer,
} from "../src/renderer/src/state/browser-composer-bridge.ts";

const payload = (targetKey: string, messageId: string) => ({
  targetKey,
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
    expect(handler).toHaveBeenCalledWith(queued);

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
    expect(secondHandler).toHaveBeenCalledWith(queued);

    unsubscribeSecond();
  });
});
