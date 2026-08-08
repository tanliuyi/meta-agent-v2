/**
 * renderer 常驻 Browser Runtime Host 测试：
 * 会话路由（create/state 按 sessionKey）、后台会话建 tab、retire 清理、
 * 会话间隔离、视图生命周期（attach/crash/stale）。
 *
 * 使用注入的假 DOM 与假 desktop API，不依赖真实 webview/网络。
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeView,
  configureBrowserRuntimeHost,
  createBlankView,
  ensureBrowserRuntime,
  getBrowserRuntime,
  resetBrowserRuntimeHostForTest,
  retireBrowserRuntime,
  subscribeBrowserCreateRequest,
  subscribeBrowserRuntime,
} from "../src/renderer/src/components/panel/browser/browser-runtime-host.ts";
import type { BrowserWebviewElement } from "../src/renderer/src/webview.d.ts";
import type { BrowserSessionIdentity, BrowserTab } from "../src/shared/browser-contracts.ts";
import { browserSessionKey } from "../src/shared/browser-contracts.ts";

/** 最小假 DOM 节点（仅 runtime host 用到的子集）。 */
class FakeNode {
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  className = "";
  style: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private webContentsId = -1;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  appendChild(node: FakeNode): FakeNode {
    if (node.parentElement) node.parentElement.removeChild(node);
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  removeChild(node: FakeNode): FakeNode {
    const index = this.children.indexOf(node);
    if (index !== -1) this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  setWebContentsId(id: number): void {
    this.webContentsId = id;
  }

  getWebContentsId(): number {
    return this.webContentsId;
  }
}

class FakeDocument {
  readonly body = new FakeNode();

  createElement(tag: string): FakeNode {
    const node = new FakeNode();
    if (tag === "webview") node.setWebContentsId(7); // 模拟已 attach 的 guest
    return node;
  }
}

interface DesktopStub {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  sessionRetire: ReturnType<typeof vi.fn>;
  onStateChanged: ReturnType<typeof vi.fn>;
  onCreateTabRequest: ReturnType<typeof vi.fn>;
  onCloseTabRequest: ReturnType<typeof vi.fn>;
  stateHandler?: (event: { sessionKey: string; tabs: BrowserTab[]; activeTabId: number | null }) => void;
  createHandler?: (request: { requestId: number; url: string; sessionKey: string }) => void;
  closeHandler?: (request: { sessionKey: string; tabId: number }) => void;
}

const SESSION_A: BrowserSessionIdentity = { projectId: "proj-a", threadId: "thread-a" };
const SESSION_B: BrowserSessionIdentity = { projectId: "proj-a", threadId: "thread-b" };

let desktop: DesktopStub;
let parking: FakeNode;
let elements: FakeNode[] = [];

function makeTab(tabId: number, url: string): BrowserTab {
  return {
    tabId,
    url,
    title: "",
    loading: false,
    crashed: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: 0,
  };
}

beforeEach(() => {
  resetBrowserRuntimeHostForTest();
  parking = new FakeNode();
  elements = [];
  desktop = {
    attach: vi.fn(async (_identity: BrowserSessionIdentity, _webContentsId: number, requestId?: number) => ({
      ok: true,
      tab: makeTab(requestId ?? 1, "about:blank"),
    })),
    detach: vi.fn(async () => undefined),
    navigate: vi.fn(async () => ({ ok: true })),
    sessionRetire: vi.fn(async () => undefined),
    onStateChanged: vi.fn((handler) => {
      desktop.stateHandler = handler;
      return () => {
        desktop.stateHandler = undefined;
      };
    }),
    onCreateTabRequest: vi.fn((handler) => {
      desktop.createHandler = handler;
      return () => {
        desktop.createHandler = undefined;
      };
    }),
    onCloseTabRequest: vi.fn((handler) => {
      desktop.closeHandler = handler;
      return () => {
        desktop.closeHandler = undefined;
      };
    }),
  };
  vi.stubGlobal("window", { desktop: { browser: desktop } });
  vi.stubGlobal("document", new FakeDocument());
  configureBrowserRuntimeHost({
    parkingHostParent: () => parking as unknown as HTMLElement,
    createContainer: () => {
      const node = new FakeNode();
      elements.push(node);
      return node as unknown as HTMLElement;
    },
    createWebviewElement: () => {
      const node = new FakeNode();
      node.setWebContentsId(7);
      elements.push(node);
      return node as unknown as BrowserWebviewElement;
    },
    attachPollIntervalMs: 1,
    attachPollMaxAttempts: 20,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function flushAttach(): Promise<void> {
  // 轮询 1ms；等几个 tick 让 attach 完成。
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("browser runtime host 会话路由", () => {
  test("ensureBrowserRuntime 幂等并按身份创建独立 runtime", () => {
    const runtimeA = ensureBrowserRuntime(SESSION_A);
    const runtimeA2 = ensureBrowserRuntime(SESSION_A);
    const runtimeB = ensureBrowserRuntime(SESSION_B);

    expect(runtimeA).toBe(runtimeA2);
    expect(runtimeA).not.toBe(runtimeB);
    expect(runtimeA.sessionKey).toBe(browserSessionKey(SESSION_A));
    expect(runtimeA.partition).not.toBe(runtimeB.partition);
    expect(getBrowserRuntime(runtimeA.sessionKey)).toBe(runtimeA);
    // 每个 runtime 有独立 parking 容器（parking host 之下）。
    const parkingHostEl = parking.children[0];
    expect(parkingHostEl.children).toHaveLength(2);
  });

  test("状态广播按 sessionKey 路由：A 的广播不影响 B", async () => {
    const runtimeA = ensureBrowserRuntime(SESSION_A);
    const runtimeB = ensureBrowserRuntime(SESSION_B);
    await flushAttach();

    desktop.stateHandler?.({
      sessionKey: browserSessionKey(SESSION_A),
      tabs: [makeTab(1, "https://a.example/")],
      activeTabId: 1,
    });

    expect(runtimeA.tabs).toHaveLength(1);
    expect(runtimeA.activeTabId).toBe(1);
    expect(runtimeB.tabs).toHaveLength(0);
  });

  test("建 tab 请求：后台会话无面板也创建 runtime + webview 并 attach（携带身份）", async () => {
    // 先安装原生订阅（任一 runtime 创建即可）。
    ensureBrowserRuntime(SESSION_B);
    const sessionKey = browserSessionKey(SESSION_A);
    desktop.createHandler?.({
      requestId: 11,
      url: "https://example.com/",
      sessionKey,
    });
    await flushAttach();

    const runtime = getBrowserRuntime(sessionKey)!;
    expect(runtime).toBeDefined();
    expect(runtime.views).toHaveLength(1);
    expect(runtime.views[0]?.pendingUrl).toBe("https://example.com/");
    expect(desktop.attach).toHaveBeenCalledWith(SESSION_A, 7, 11);
  });

  test("面板挂载后重放未完成建 tab 请求（不丢失 requestId）", async () => {
    // 先安装原生订阅。
    ensureBrowserRuntime(SESSION_B);
    const sessionKey = browserSessionKey(SESSION_A);
    desktop.createHandler?.({
      requestId: 21,
      url: "https://example.com/",
      sessionKey,
    });
    // runtime 已由请求创建；这里模拟“面板稍后挂载”再次 ensure（幂等，不重复创建）。
    const runtime = ensureBrowserRuntime(SESSION_A);
    await flushAttach();

    expect(runtime.views).toHaveLength(1);
    expect(desktop.attach).toHaveBeenCalledTimes(1);
    expect(desktop.attach).toHaveBeenCalledWith(SESSION_A, 7, 21);
  });

  test("建 tab 请求按会话路由：B 的请求不创建 A 的视图", async () => {
    const runtimeA = ensureBrowserRuntime(SESSION_A);
    const runtimeB = ensureBrowserRuntime(SESSION_B);

    desktop.createHandler?.({
      requestId: 31,
      url: "https://b.example/",
      sessionKey: browserSessionKey(SESSION_B),
    });
    await flushAttach();

    expect(runtimeA.views).toHaveLength(0);
    expect(runtimeB.views).toHaveLength(1);
    expect(desktop.attach).toHaveBeenCalledWith(SESSION_B, 7, 31);
  });

  test("关闭 tab 请求：按 tabId 删除视图并 detach（不重建）", async () => {
    const runtime = ensureBrowserRuntime(SESSION_A);
    desktop.createHandler?.({
      requestId: 41,
      url: "https://example.com/",
      sessionKey: runtime.sessionKey,
    });
    await flushAttach();
    expect(runtime.views).toHaveLength(1);

    desktop.closeHandler?.({ sessionKey: runtime.sessionKey, tabId: 41 });
    expect(runtime.views).toHaveLength(0);
    expect(desktop.detach).toHaveBeenCalledWith(SESSION_A, 7);

    // 幂等：重复关闭不报错、无副作用。
    desktop.closeHandler?.({ sessionKey: runtime.sessionKey, tabId: 41 });
    expect(desktop.detach).toHaveBeenCalledTimes(1);
  });

  test("subscribeBrowserCreateRequest 首次订阅即安装原生监听并按会话过滤", async () => {
    const sessionKey = browserSessionKey(SESSION_A);
    const opened: string[] = [];
    const unsubscribe = subscribeBrowserCreateRequest(sessionKey, () => opened.push(sessionKey));
    const unsubscribeB = subscribeBrowserCreateRequest(browserSessionKey(SESSION_B), () => opened.push("b"));

    desktop.createHandler?.({
      requestId: 41,
      url: "https://a.example/",
      sessionKey,
    });

    expect(opened).toEqual([sessionKey]);
    unsubscribe();
    unsubscribeB();
  });

  test("runtime 变更订阅：attach 完成后通知面板", async () => {
    const runtime = ensureBrowserRuntime(SESSION_A);
    const notifications: number[] = [];
    const unsubscribe = subscribeBrowserRuntime(runtime.sessionKey, () => notifications.push(runtime.version));

    desktop.createHandler?.({
      requestId: 51,
      url: "https://example.com/",
      sessionKey: runtime.sessionKey,
    });
    await flushAttach();

    expect(notifications.length).toBeGreaterThan(0);
    expect(runtime.views).toHaveLength(1);
    unsubscribe();
  });

  test("retire 清理 webview/guest/映射且不影响其他会话", async () => {
    const runtimeA = ensureBrowserRuntime(SESSION_A);
    const runtimeB = ensureBrowserRuntime(SESSION_B);
    desktop.createHandler?.({
      requestId: 61,
      url: "https://a.example/",
      sessionKey: runtimeA.sessionKey,
    });
    await flushAttach();

    await retireBrowserRuntime(runtimeA.sessionKey);

    expect(desktop.detach).toHaveBeenCalledWith(SESSION_A, 7);
    expect(desktop.sessionRetire).toHaveBeenCalledWith(SESSION_A);
    expect(getBrowserRuntime(runtimeA.sessionKey)).toBeUndefined();
    expect(parking.children).toHaveLength(1);
    // B 不受影响。
    expect(getBrowserRuntime(runtimeB.sessionKey)).toBe(runtimeB);
    // 旧 runtime 已经冻结并清空；B 不受影响，后续同 key runtime 会获得全新视图集合。
    expect(runtimeA.views).toHaveLength(0);
  });

  test("视图关闭/崩溃/重建不调用全局 detach 之外的清理", async () => {
    const runtime = ensureBrowserRuntime(SESSION_A);
    createBlankView(runtime);
    await flushAttach();

    expect(runtime.views).toHaveLength(1);
    expect(desktop.attach).toHaveBeenCalledWith(SESSION_A, 7, undefined);
    // 关闭视图：detach 一次、元素移除、映射清空。
    closeView(runtime, runtime.views[0]!.viewId);
    expect(desktop.detach).toHaveBeenCalledWith(SESSION_A, 7);
    expect(runtime.views).toHaveLength(0);
  });

  test("guest destroyed 后清除登记，新 guest 的 did-attach 重新 attach", async () => {
    const runtime = ensureBrowserRuntime(SESSION_A);
    createBlankView(runtime);
    await flushAttach();
    expect(desktop.attach).toHaveBeenCalledTimes(1);

    // 模拟 main 广播 tab 状态（attach 成功后）。
    desktop.stateHandler?.({
      sessionKey: runtime.sessionKey,
      tabs: [makeTab(1, "about:blank")],
      activeTabId: 1,
    });
    expect(runtime.tabs).toHaveLength(1);

    // guest 销毁（元素仍在 DOM，例如视口与 parking host 间移动）：视图保留，登记清除。
    const element = elements.at(-1)!;
    element.emit("destroyed");
    expect(runtime.views).toHaveLength(1);
    expect(runtime.tabs).toHaveLength(1);

    // 新 guest 的 did-attach：旧登记已清除，重新 attach（不因残留登记被跳过）。
    element.emit("did-attach");
    await flushAttach();
    expect(desktop.attach).toHaveBeenCalledTimes(2);
  });
});
