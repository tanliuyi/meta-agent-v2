import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followResizingContentToBottom } from "../src/renderer/src/shared/lib/follow-resizing-content-to-bottom.ts";

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
    clientHeight: 100,
    scrollHeight: 240,
    scrollTop: 0,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
    dispatchScroll() {
      listeners.get("scroll")?.(new Event("scroll"));
    },
  };
}

describe("tool detail bottom follow", () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    frames.length = 0;
    ResizeObserverStub.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins overflowing details initially and after a streaming delta", () => {
    const viewport = createViewport();
    const content = {} as Element;
    followResizingContentToBottom(viewport, content);

    expect(ResizeObserverStub.instances[0]?.observe).toHaveBeenCalledWith(content);
    frames.shift()?.(0);
    expect(viewport.scrollTop).toBe(240);

    viewport.scrollHeight = 420;
    ResizeObserverStub.instances[0]?.resize();
    frames.shift()?.(1);
    expect(viewport.scrollTop).toBe(420);
  });

  it("keeps following when content growth fires a scroll event before the next pin", () => {
    const viewport = createViewport();
    followResizingContentToBottom(viewport, {} as Element, { respectUserScroll: true });
    frames.shift()?.(0);

    viewport.scrollHeight = 420;
    ResizeObserverStub.instances[0]?.resize();
    viewport.dispatchScroll();
    frames.shift()?.(1);

    expect(viewport.scrollTop).toBe(420);
  });

  it("stops following after the user scrolls up while content is stable", () => {
    const viewport = createViewport();
    followResizingContentToBottom(viewport, {} as Element, { respectUserScroll: true });
    frames.shift()?.(0);

    viewport.scrollHeight = 420;
    viewport.scrollTop = 320;
    viewport.dispatchScroll();
    viewport.scrollTop = 220;
    viewport.dispatchScroll();
    viewport.scrollHeight = 600;
    ResizeObserverStub.instances[0]?.resize();
    frames.shift()?.(1);

    expect(viewport.scrollTop).toBe(220);
  });

  it("does not scroll non-overflowing details and cleans up pending work", () => {
    const viewport = { clientHeight: 100, scrollHeight: 80, scrollTop: 0 };
    const stop = followResizingContentToBottom(viewport, {} as Element);

    frames.shift()?.(0);
    expect(viewport.scrollTop).toBe(0);

    ResizeObserverStub.instances[0]?.resize();
    stop();
    expect(ResizeObserverStub.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  });
});
