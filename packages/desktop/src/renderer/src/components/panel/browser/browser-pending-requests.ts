/**
 * 内置浏览器（IAB）建 tab 请求的 renderer 侧缓冲。
 *
 * main 进程的工具调用（browser.open 等）经 `browserCreateTabRequest` 事件
 * 到达 renderer；浏览器面板可能尚未挂载（workbench 面板未打开）。本模块做
 * 模块级缓冲：请求先存入 Map 并通知订阅者，面板挂载时消费存量请求，后续
 * 请求到达时即时通知已挂载的面板。请求与 view 的对应通过 requestId 传递
 * 给 `window.desktop.browser.attach(webContentsId, requestId)`，由 main 侧
 * resolve 对应的 pending 建 tab 操作并自动导航。
 */

import type { BrowserCreateTabRequest } from "../../../../../shared/browser-contracts.ts";
import { BROWSER_PANEL_KIND } from "../builtin-panel-kinds.ts";

export interface PendingCreateTabRequest {
  requestId: number;
  url: string;
}

const pending = new Map<number, PendingCreateTabRequest>();
const listeners = new Set<(request: PendingCreateTabRequest) => void>();
const deliveredRequestIds = new Set<number>();

export interface BrowserRequestOwner {
  openPanelTab(panel: string): void;
}

let nextOwnerId = 1;
const owners = new Map<number, BrowserRequestOwner>();
let unsubscribeNativeCreateTabRequest: (() => void) | undefined;

/** Register one renderer-window owner for the global create-tab event. */
export function registerBrowserRequestOwner(owner: BrowserRequestOwner): () => void {
  const ownerId = nextOwnerId++;
  owners.set(ownerId, owner);
  if (!unsubscribeNativeCreateTabRequest) {
    unsubscribeNativeCreateTabRequest = window.desktop.browser.onCreateTabRequest((request) => {
      const selectedOwner = owners.values().next().value;
      if (!selectedOwner) return;
      bufferCreateTabRequest(request);
      selectedOwner.openPanelTab(BROWSER_PANEL_KIND);
    });
  }

  return () => {
    if (!owners.delete(ownerId) || owners.size > 0) return;
    unsubscribeNativeCreateTabRequest?.();
    unsubscribeNativeCreateTabRequest = undefined;
  };
}

/**
 * main 请求到达：面板已挂载则直接通知（请求被消费，不入缓冲），否则存入缓冲待面板挂载时取用。
 * `registerBrowserRequestOwner` 保证同一 renderer 窗口只有一个 Workbench owner 打开面板。
 */
export function bufferCreateTabRequest(request: BrowserCreateTabRequest): void {
  const entry: PendingCreateTabRequest = { requestId: request.requestId, url: request.url };
  if (listeners.size > 0) {
    if (deliveredRequestIds.has(request.requestId)) return;
    deliveredRequestIds.add(request.requestId);
    queueMicrotask(() => deliveredRequestIds.delete(request.requestId));
    // 浏览器是全局单例；只交给一个当前订阅者，避免多个 session 同时创建同一 requestId 的 view。
    const listener = listeners.values().next().value;
    listener?.(entry);
    return;
  }
  pending.set(request.requestId, entry);
}

/** 面板挂载时消费存量请求（全部取出并清空缓冲）。 */
export function takeAllPendingCreateTabRequests(): PendingCreateTabRequest[] {
  const entries = [...pending.values()];
  pending.clear();
  return entries;
}

/** 订阅后续请求；同一时刻只由最早订阅的面板消费，返回取消订阅函数。 */
export function consumeCreateTabRequests(listener: (request: PendingCreateTabRequest) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
