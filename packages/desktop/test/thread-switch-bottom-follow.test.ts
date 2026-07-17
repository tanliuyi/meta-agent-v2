import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followThreadSwitchToBottom } from "../src/renderer/src/components/chat/thread-switch-bottom-follow.ts";

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  resize() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function createViewport() {
  const listeners = new Map<string, EventListener>();
  return {
    scrollHeight: 400,
    scrollTop: 0,
    style: { scrollBehavior: "smooth" },
    addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    dispatch(type: string) {
      listeners.get(type)?.(new Event(type));
    },
  };
}

describe("thread switch bottom follow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ResizeObserverStub.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("切换后立即追底，并在初始内容增高时继续校正", () => {
    const viewport = createViewport();
    followThreadSwitchToBottom(viewport, {} as Element);

    expect(viewport.scrollTop).toBe(400);
    expect(viewport.style.scrollBehavior).toBe("auto");
    viewport.scrollHeight = 900;
    ResizeObserverStub.instances[0]?.resize();
    expect(viewport.scrollTop).toBe(900);
  });

  it("用户开始滚动后停止追底", () => {
    const viewport = createViewport();
    followThreadSwitchToBottom(viewport, {} as Element);

    viewport.dispatch("wheel");
    viewport.scrollHeight = 900;
    ResizeObserverStub.instances[0]?.resize();

    expect(viewport.scrollTop).toBe(400);
    expect(ResizeObserverStub.instances[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it("稳定窗口结束后释放 observer 和事件监听", () => {
    const viewport = createViewport();
    followThreadSwitchToBottom(viewport, {} as Element, 100);

    vi.advanceTimersByTime(100);

    expect(ResizeObserverStub.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(viewport.style.scrollBehavior).toBe("smooth");
    expect(viewport.removeEventListener).toHaveBeenCalledTimes(3);
  });
});
