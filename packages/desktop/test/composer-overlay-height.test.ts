import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeComposerOverlayHeight } from "../src/renderer/src/components/chat/composer-overlay-height.ts";

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

describe("composer overlay height", () => {
  beforeEach(() => {
    ResizeObserverStub.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("同步 footer 高度，并在原本位于底部时保持追底", () => {
    let footerHeight = 96;
    let scrollHeight = 700;
    let scrollTop = 200;
    const clientHeight = 500;
    const clientWidth = 990;
    const offsetWidth = 1000;
    const style = {
      setProperty: vi.fn((property: string, value: string) => {
        if (property === "--composer-overlay-height") scrollHeight = 604 + Number.parseInt(value, 10);
      }),
      removeProperty: vi.fn(),
    };
    const root = { style } as unknown as HTMLElement;
    const viewport = {
      get clientHeight() {
        return clientHeight;
      },
      get clientWidth() {
        return clientWidth;
      },
      get offsetWidth() {
        return offsetWidth;
      },
      get scrollHeight() {
        return scrollHeight;
      },
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = Math.min(value, scrollHeight - clientHeight);
      },
    } as HTMLElement;
    const footer = {
      get offsetHeight() {
        return footerHeight;
      },
    } as HTMLElement;

    const cleanup = observeComposerOverlayHeight(root, viewport, footer);

    expect(style.setProperty).toHaveBeenCalledWith("--composer-overlay-height", "96px");
    expect(style.setProperty).toHaveBeenCalledWith("--thread-scrollbar-width", "10px");
    expect(ResizeObserverStub.instances[0]?.observe).toHaveBeenCalledWith(viewport);
    expect(ResizeObserverStub.instances[0]?.observe).toHaveBeenCalledWith(footer);
    expect(scrollTop).toBe(200);

    footerHeight = 144;
    ResizeObserverStub.instances[0]?.resize();
    expect(style.setProperty).toHaveBeenCalledWith("--composer-overlay-height", "144px");
    expect(scrollTop).toBe(248);

    scrollTop = 100;
    footerHeight = 160;
    ResizeObserverStub.instances[0]?.resize();
    expect(scrollTop).toBe(100);

    cleanup();
    expect(ResizeObserverStub.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(style.removeProperty).toHaveBeenCalledWith("--composer-overlay-height");
    expect(style.removeProperty).toHaveBeenCalledWith("--thread-scrollbar-width");
  });
});
