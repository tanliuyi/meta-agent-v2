/**
 * renderer 侧建 tab 请求缓冲（browser-pending-requests）测试：
 * 面板未挂载时请求入缓冲、面板已挂载时直通消费、消费后清空。
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  bufferCreateTabRequest,
  consumeCreateTabRequests,
  registerBrowserRequestOwner,
  takeAllPendingCreateTabRequests,
} from "../src/renderer/src/components/panel/browser/browser-pending-requests.ts";
import { BROWSER_PANEL_KIND } from "../src/renderer/src/components/panel/builtin-panel-kinds.ts";

afterEach(() => {
  takeAllPendingCreateTabRequests();
  vi.unstubAllGlobals();
});

describe("browser pending create-tab requests", () => {
  test("无订阅者时请求入缓冲，takeAll 取出并清空", () => {
    bufferCreateTabRequest({ requestId: 1, url: "https://a.example/" });
    bufferCreateTabRequest({ requestId: 2, url: "https://b.example/" });

    const taken = takeAllPendingCreateTabRequests();
    expect(taken.map((request) => request.requestId)).toEqual([1, 2]);
    expect(takeAllPendingCreateTabRequests()).toEqual([]);
  });

  test("有订阅者时请求直通通知且不入缓冲（避免面板卸载重放）", () => {
    const received: Array<{ requestId: number; url: string }> = [];
    const unsubscribe = consumeCreateTabRequests((request) => received.push(request));

    bufferCreateTabRequest({ requestId: 3, url: "https://c.example/" });

    expect(received).toEqual([{ requestId: 3, url: "https://c.example/" }]);
    expect(takeAllPendingCreateTabRequests()).toEqual([]);
    unsubscribe();
  });

  test("多个 session 订阅者时只通知一个面板", () => {
    const first: Array<{ requestId: number; url: string }> = [];
    const second: Array<{ requestId: number; url: string }> = [];
    const unsubscribeFirst = consumeCreateTabRequests((request) => first.push(request));
    const unsubscribeSecond = consumeCreateTabRequests((request) => second.push(request));

    bufferCreateTabRequest({ requestId: 5, url: "https://e.example/" });
    bufferCreateTabRequest({ requestId: 5, url: "https://e.example/" });

    expect(first).toEqual([{ requestId: 5, url: "https://e.example/" }]);
    expect(second).toEqual([]);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  test("窗口内多个 owner 只建立一个原生订阅并在 owner 退出后交接", () => {
    type CreateTabHandler = (request: { requestId: number; url: string }) => void;
    const nativeHandlers = new Set<CreateTabHandler>();
    const removeNative = vi.fn();
    const onCreateTabRequest = vi.fn((handler: CreateTabHandler) => {
      nativeHandlers.add(handler);
      return () => {
        nativeHandlers.delete(handler);
        removeNative();
      };
    });
    vi.stubGlobal("window", { desktop: { browser: { onCreateTabRequest } } });

    const first = { openPanelTab: vi.fn() };
    const second = { openPanelTab: vi.fn() };
    const releaseFirst = registerBrowserRequestOwner(first);
    const releaseSecond = registerBrowserRequestOwner(second);

    expect(onCreateTabRequest).toHaveBeenCalledOnce();
    for (const handler of nativeHandlers) handler({ requestId: 10, url: "https://first.example/" });
    expect(first.openPanelTab).toHaveBeenCalledWith(BROWSER_PANEL_KIND);
    expect(second.openPanelTab).not.toHaveBeenCalled();

    releaseFirst();
    for (const handler of nativeHandlers) handler({ requestId: 11, url: "https://second.example/" });
    expect(second.openPanelTab).toHaveBeenCalledWith(BROWSER_PANEL_KIND);

    releaseSecond();
    expect(removeNative).toHaveBeenCalledOnce();
  });

  test("取消订阅后请求重新入缓冲", () => {
    const received: Array<{ requestId: number; url: string }> = [];
    const unsubscribe = consumeCreateTabRequests((request) => received.push(request));
    unsubscribe();

    bufferCreateTabRequest({ requestId: 4, url: "https://d.example/" });

    expect(received).toEqual([]);
    expect(takeAllPendingCreateTabRequests().map((request) => request.requestId)).toEqual([4]);
  });
});
