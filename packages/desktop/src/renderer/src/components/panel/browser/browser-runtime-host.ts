/**
 * renderer 常驻的浏览器 Runtime Host（按会话隔离）。
 *
 * 每个会话（browserSessionKey）维护一组常驻 webview（parking host 容器内，
 * 不随 BrowserPanel 卸载/会话切换销毁）。main 的状态广播与建 tab 请求按
 * sessionKey 路由到对应 runtime；后台会话的普通工具请求（open/navigate/
 * snapshot/...）直接在它自己的后台 webview/profile 上执行，不要求该会话在前台。
 *
 * webview 元素由本模块命令式创建并持有（不在 React 树内）；BrowserPanel
 * 通过 `displayWebview` 把活跃 tab 的 webview 元素临时移入面板视口（guest
 * webContents 跟随元素迁移，不重建），面板卸载/切换时元素回到 parking host，
 * 不调用 browser.detach。会话记录退役（session retire）时清理 webview/guest
 * 与全部映射。
 */

import { useEffect } from "react";
import type {
  BrowserCloseTabRequest,
  BrowserCreateTabRequest,
  BrowserSessionIdentity,
  BrowserStateEvent,
  BrowserTab,
} from "../../../../../shared/browser-contracts.ts";
import { browserPartitionFor, browserSessionKey } from "../../../../../shared/browser-contracts.ts";
import { registerBrowserRuntimeRetirer } from "../../../state/session-cache-context.tsx";
import type { BrowserWebviewElement } from "../../../webview.d.ts";

/** renderer 侧一个浏览器视图（对应一个 <webview> 元素）。 */
export interface BrowserViewRecord {
  /** runtime 内自增 id，作为 key 与元素映射键。 */
  viewId: number;
  /** guest 渲染进程崩溃，占位待重建。 */
  crashed: boolean;
  /** 创建/重建后希望打开的 URL（空 = 保持 about:blank）。 */
  pendingUrl: string;
  /** main 建 tab 请求的 requestId（attach 时传给 main，由其 resolve 并自动导航）。 */
  pendingRequestId?: number;
  /** 强制重建 webview 元素的递增号（attach 失败/卡住时用）。 */
  remountEpoch: number;
  /** guest 已销毁、Electron 正在自动重建新 guest 中：不参与面板显示切换，避免闪烁。 */
  rebuilding?: boolean;
}

/** 一个会话的常驻浏览器运行时（视图/tab 状态；面板与后台共用）。 */
export interface SessionBrowserRuntime {
  readonly identity: BrowserSessionIdentity;
  readonly sessionKey: string;
  readonly partition: string;
  /** 有序视图列表（面板 tab 栏与后台共用）。 */
  views: BrowserViewRecord[];
  /** main 广播的会话 tabs（唯一状态源）。 */
  tabs: BrowserTab[];
  activeTabId: number | null;
  /** attach 失败等可展示错误（面板显示；后台会话不打扰）。 */
  attachError: string | null;
  /** 变更计数：面板订阅后据此重渲染。 */
  version: number;
  /** parking host 子容器：webview 元素常驻于此（React 树外）。 */
  readonly container: HTMLElement;
}

interface RuntimeInternals {
  runtime: SessionBrowserRuntime;
  /** runtime 正在退役；禁止状态事件和 attach 回调重建新视图。 */
  retiring: boolean;
  /** viewId -> guest webContentsId（已 attach）。 */
  webContentsIdByView: Map<number, number>;
  /** viewId -> BrowserManager 分配的 tabId。 */
  tabIdByView: Map<number, number>;
  /** tabId -> viewId。 */
  viewIdByTabId: Map<number, number>;
  /** viewId -> 元素（attach 竞态防串代）。 */
  elementByView: Map<number, BrowserWebviewElement>;
  /** 已处理的建 tab 请求（避免 replay 重复创建）。 */
  handledRequestIds: Set<number>;
  /** viewId -> attach 轮询定时器（卸载时清理）。 */
  pollTimers: Map<number, ReturnType<typeof setInterval>>;
  /** 元素事件监听（移除元素时清理）。 */
  elementCleanups: Map<number, () => void>;
}

interface PendingCreateTabRequest {
  requestId: number;
  url: string;
  sessionKey: string;
}

export interface BrowserRuntimeHostOptions {
  /** 测试注入：创建 webview 元素。 */
  createWebviewElement?: () => BrowserWebviewElement;
  /** 测试注入：parking host 父节点（默认 document.body）。 */
  parkingHostParent?: () => HTMLElement | null;
  /** 测试注入：创建容器元素（默认 document.createElement("div")）。 */
  createContainer?: () => HTMLElement;
  /** 测试注入：attach 轮询间隔与次数。 */
  attachPollIntervalMs?: number;
  attachPollMaxAttempts?: number;
}

const runtimeOptions: Required<Pick<BrowserRuntimeHostOptions, "attachPollIntervalMs" | "attachPollMaxAttempts">> & {
  createWebviewElement?: () => BrowserWebviewElement;
  parkingHostParent?: () => HTMLElement | null;
  createContainer?: () => HTMLElement;
} = {
  attachPollIntervalMs: 500,
  attachPollMaxAttempts: 10,
};

/** 配置运行时宿主（测试注入；必须在创建 runtime 前调用）。 */
export function configureBrowserRuntimeHost(options: BrowserRuntimeHostOptions): void {
  if (options.createWebviewElement !== undefined) runtimeOptions.createWebviewElement = options.createWebviewElement;
  if (options.parkingHostParent !== undefined) runtimeOptions.parkingHostParent = options.parkingHostParent;
  if (options.createContainer !== undefined) runtimeOptions.createContainer = options.createContainer;
  if (options.attachPollIntervalMs !== undefined) runtimeOptions.attachPollIntervalMs = options.attachPollIntervalMs;
  if (options.attachPollMaxAttempts !== undefined) runtimeOptions.attachPollMaxAttempts = options.attachPollMaxAttempts;
}

/** 清空全部模块状态（测试专用：重置订阅、runtime、缓冲与 parking host）。 */
export function resetBrowserRuntimeHostForTest(): void {
  nativeStateUnsubscribe?.();
  nativeCreateUnsubscribe?.();
  nativeCloseUnsubscribe?.();
  nativeStateUnsubscribe = undefined;
  nativeCreateUnsubscribe = undefined;
  nativeCloseUnsubscribe = undefined;
  runtimes.clear();
  internalsByKey.clear();
  runtimeListeners.clear();
  createRequestListeners.clear();
  pendingCreateRequests.clear();
  notifiedRequestIds.clear();
  bufferedStateEvents.clear();
  retirePromises.clear();
  parkingHost = null;
  nextViewId = 1;
}

const runtimes = new Map<string, SessionBrowserRuntime>();
const internalsByKey = new Map<string, RuntimeInternals>();
const runtimeListeners = new Map<string, Set<() => void>>();
const createRequestListeners = new Map<string, Set<() => void>>();
const pendingCreateRequests = new Map<string, PendingCreateTabRequest>();
const notifiedRequestIds = new Set<string>();
const bufferedStateEvents = new Map<string, BrowserStateEvent>();
const retirePromises = new Map<string, Promise<void>>();
let parkingHost: HTMLElement | null = null;
let nextViewId = 1;
let nativeStateUnsubscribe: (() => void) | undefined;
let nativeCreateUnsubscribe: (() => void) | undefined;
let nativeCloseUnsubscribe: (() => void) | undefined;

function createRequestKey(sessionKey: string, requestId: number): string {
  return `${sessionKey}\u0000${requestId}`;
}

/** 应用级 runtime host；必须在任何 BrowserPanel 挂载前建立 native 订阅。 */
export function BrowserRuntimeHost(): null {
  useEffect(() => {
    const unregisterBrowserRuntime = registerBrowserRuntimeRetirer(retireBrowserRuntime);
    ensureNativeSubscriptions();
    return () => {
      unregisterBrowserRuntime();
      nativeStateUnsubscribe?.();
      nativeCreateUnsubscribe?.();
      nativeCloseUnsubscribe?.();
      nativeStateUnsubscribe = undefined;
      nativeCreateUnsubscribe = undefined;
      nativeCloseUnsubscribe = undefined;
    };
  }, []);
  return null;
}

function ensureParkingHost(): HTMLElement {
  if (parkingHost) return parkingHost;
  const parent = runtimeOptions.parkingHostParent?.() ?? document.body;
  const host = runtimeOptions.createContainer?.() ?? document.createElement("div");
  host.className = "browser-parking-host";
  host.setAttribute("data-browser-parking-host", "");
  // 常驻且不可见；guest webContents 保持存活（导航/截图/CDP 不受影响）。
  parent.appendChild(host);
  parkingHost = host;
  return host;
}

function ensureNativeSubscriptions(): void {
  if (nativeStateUnsubscribe || typeof window === "undefined" || !window.desktop?.browser) return;
  nativeStateUnsubscribe = window.desktop.browser.onStateChanged((event) => {
    const internals = internalsByKey.get(event.sessionKey);
    if (internals) applyStateEvent(internals, event);
    else bufferedStateEvents.set(event.sessionKey, event);
  });
  nativeCreateUnsubscribe = window.desktop.browser.onCreateTabRequest((request) => {
    handleNativeCreateTabRequest(request);
  });
  nativeCloseUnsubscribe = window.desktop.browser.onCloseTabRequest((request) => {
    handleNativeCloseTabRequest(request);
  });
}

/** 工具 browser.close：按 tabId 找到视图并关闭（删除视图 + detach，不重建）。 */
function handleNativeCloseTabRequest(request: BrowserCloseTabRequest): void {
  const internals = internalsByKey.get(request.sessionKey);
  if (!internals) return;
  const viewId = internals.viewIdByTabId.get(request.tabId);
  if (viewId === undefined) return;
  // 与面板 closeView 同一路径：移除元素 + detach（main 侧随之移除 entry）。
  removeViewInternal(internals, viewId);
  markChanged(internals);
}

function handleNativeCreateTabRequest(request: BrowserCreateTabRequest): void {
  const key = createRequestKey(request.sessionKey, request.requestId);
  pendingCreateRequests.set(key, {
    requestId: request.requestId,
    url: request.url,
    sessionKey: request.sessionKey,
  });
  // 后台会话也可能在无面板时收到工具建 tab 请求：立即创建 runtime + webview，
  // attach 后 main 侧 resolve（不要求该会话在前台）。
  const identity = identityFromSessionKey(request.sessionKey);
  if (identity) ensureBrowserRuntime(identity);
  const internals = internalsByKey.get(request.sessionKey);
  if (internals && !internals.handledRequestIds.has(request.requestId)) {
    createViewForRequest(internals, request.requestId);
  }
  if (!notifiedRequestIds.has(key)) {
    notifiedRequestIds.add(key);
    const listeners = createRequestListeners.get(request.sessionKey);
    if (listeners) {
      for (const listener of [...listeners]) listener();
    }
  }
}

/** 从 sessionKey（`projectId\u0000threadId`）还原会话身份；格式非法时返回 null。 */
function identityFromSessionKey(sessionKey: string): BrowserSessionIdentity | null {
  const separator = sessionKey.indexOf("\u0000");
  if (separator === -1) return null;
  const projectId = sessionKey.slice(0, separator);
  const threadId = sessionKey.slice(separator + 1);
  if (projectId.length === 0 || threadId.length === 0) return null;
  return { projectId, threadId };
}

/** 创建（或复用）会话 runtime；重放未处理的建 tab 请求并应用缓冲状态。 */
export function ensureBrowserRuntime(identity: BrowserSessionIdentity): SessionBrowserRuntime {
  ensureNativeSubscriptions();
  const sessionKey = browserSessionKey(identity);
  const existing = runtimes.get(sessionKey);
  if (existing) return existing;

  const container = runtimeOptions.createContainer?.() ?? document.createElement("div");
  container.className = "browser-session-runtime";
  container.setAttribute("data-browser-session", sessionKey);
  ensureParkingHost().appendChild(container);
  const runtime: SessionBrowserRuntime = {
    identity: { ...identity },
    sessionKey,
    partition: browserPartitionFor(identity),
    views: [],
    tabs: [],
    activeTabId: null,
    attachError: null,
    version: 1,
    container,
  };
  const internals: RuntimeInternals = {
    runtime,
    webContentsIdByView: new Map(),
    tabIdByView: new Map(),
    viewIdByTabId: new Map(),
    elementByView: new Map(),
    handledRequestIds: new Set(),
    pollTimers: new Map(),
    elementCleanups: new Map(),
    retiring: false,
  };
  runtimes.set(sessionKey, runtime);
  internalsByKey.set(sessionKey, internals);

  const buffered = bufferedStateEvents.get(sessionKey);
  if (buffered) {
    bufferedStateEvents.delete(sessionKey);
    applyStateEvent(internals, buffered);
  }
  // 重放未完成的建 tab 请求（StrictMode 首挂载丢失修复：模块级缓冲不随组件生命周期丢失）。
  for (const request of pendingCreateRequests.values()) {
    if (request.sessionKey !== sessionKey || internals.handledRequestIds.has(request.requestId)) continue;
    createViewForRequest(internals, request.requestId);
  }
  return runtime;
}

export function getBrowserRuntime(sessionKey: string): SessionBrowserRuntime | undefined {
  return runtimes.get(sessionKey);
}

export function hasBrowserRuntime(sessionKey: string): boolean {
  return runtimes.has(sessionKey);
}

/** 订阅 runtime 变更（版本递增即通知）；返回取消订阅函数。 */
export function subscribeBrowserRuntime(sessionKey: string, listener: () => void): () => void {
  if (!nativeStateUnsubscribe && typeof window !== "undefined" && window.desktop?.browser) {
    ensureNativeSubscriptions();
  }
  let listeners = runtimeListeners.get(sessionKey);
  if (!listeners) {
    listeners = new Set();
    runtimeListeners.set(sessionKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅本会话的建 tab 请求到达（打开浏览器面板用）；订阅时重放未完成请求。 */
export function subscribeBrowserCreateRequest(sessionKey: string, listener: () => void): () => void {
  ensureNativeSubscriptions();
  let listeners = createRequestListeners.get(sessionKey);
  if (!listeners) {
    listeners = new Set();
    createRequestListeners.set(sessionKey, listeners);
  }
  listeners.add(listener);
  for (const request of pendingCreateRequests.values()) {
    if (request.sessionKey !== sessionKey || notifiedRequestIds.has(createRequestKey(sessionKey, request.requestId)))
      continue;
    notifiedRequestIds.add(createRequestKey(sessionKey, request.requestId));
    listener();
    break;
  }
  return () => {
    listeners.delete(listener);
  };
}

export function retireBrowserRuntime(sessionKey: string): Promise<void> {
  const ongoing = retirePromises.get(sessionKey);
  if (ongoing) return ongoing;
  const promise = retireBrowserRuntimeInternal(sessionKey);
  retirePromises.set(sessionKey, promise);
  const clear = (): void => {
    if (retirePromises.get(sessionKey) === promise) retirePromises.delete(sessionKey);
  };
  void promise.then(clear, clear);
  return promise;
}

/** 会话退役：先冻结并摘除 runtime，再异步注销 main guest；幂等且防止旧清理删除新 generation。 */
async function retireBrowserRuntimeInternal(sessionKey: string): Promise<void> {
  const internals = internalsByKey.get(sessionKey);
  if (!internals || internals.retiring) return;
  internals.retiring = true;
  const runtime = internals.runtime;
  const identity = runtime.identity;
  const webContentsIds = [...internals.webContentsIdByView.values()];
  const elements = [...internals.elementByView.entries()];

  // 先从全局 registry 摘除，后续状态广播和迟到 attach 只能走新 generation。
  if (runtimes.get(sessionKey) === runtime) runtimes.delete(sessionKey);
  if (internalsByKey.get(sessionKey) === internals) internalsByKey.delete(sessionKey);
  runtimeListeners.delete(sessionKey);
  createRequestListeners.delete(sessionKey);
  bufferedStateEvents.delete(sessionKey);
  for (const [requestKey, request] of [...pendingCreateRequests]) {
    if (request.sessionKey !== sessionKey) continue;
    pendingCreateRequests.delete(requestKey);
    notifiedRequestIds.delete(requestKey);
  }

  for (const [viewId, element] of elements) {
    internals.elementCleanups.get(viewId)?.();
    try {
      element.remove();
    } catch {
      // 元素可能已不在 DOM。
    }
  }
  internals.elementByView.clear();
  internals.webContentsIdByView.clear();
  internals.tabIdByView.clear();
  internals.viewIdByTabId.clear();
  for (const timer of internals.pollTimers.values()) clearInterval(timer);
  internals.pollTimers.clear();
  internals.elementCleanups.clear();
  runtime.views = [];
  runtime.tabs = [];
  runtime.activeTabId = null;
  try {
    runtime.container.remove();
  } catch {
    // 容器可能已被外部移除。
  }

  for (const webContentsId of webContentsIds) {
    try {
      await window.desktop.browser.detach(identity, webContentsId);
    } catch {
      // guest 可能已销毁；忽略。
    }
  }
  // 同一 key 在清理期间若已创建新 runtime，新 generation 不能被旧 retire 注销。
  if (!runtimes.has(sessionKey)) {
    try {
      await window.desktop.browser.sessionRetire(identity);
    } catch {
      // main 侧清理失败不阻断 renderer 清理。
    }
  }
}

/** 面板“新建标签页”：创建一个空白视图并 attach。 */
export function createBlankView(runtime: SessionBrowserRuntime): void {
  createView(runtime, "");
}

/** 创建带目标 URL 的视图（attach 完成后自动导航；恢复标签页用）。 */
export function createView(runtime: SessionBrowserRuntime, pendingUrl: string): void {
  const internals = internalsOf(runtime);
  createViewInternal(internals, pendingUrl, undefined);
}

/** 关闭视图：detach + 移除元素与映射。 */
export function closeView(runtime: SessionBrowserRuntime, viewId: number): void {
  const internals = internalsOf(runtime);
  removeViewInternal(internals, viewId);
  markChanged(internals);
}

/** 崩溃重建：移除旧元素，用原 URL 重建并重新 attach。 */
export function rebuildView(runtime: SessionBrowserRuntime, viewId: number): void {
  const internals = internalsOf(runtime);
  const record = internals.runtime.views.find((view) => view.viewId === viewId);
  if (!record) return;
  const url = record.pendingUrl;
  removeViewInternal(internals, viewId);
  createViewInternal(internals, url, undefined);
  markChanged(internals);
}

/** 强制重建视图元素（attach 失败/卡住时用）。 */
export function remountView(runtime: SessionBrowserRuntime, viewId: number): void {
  const internals = internalsOf(runtime);
  const record = internals.runtime.views.find((view) => view.viewId === viewId);
  if (!record) return;
  const url = record.pendingUrl || tabUrlOf(internals, viewId);
  removeViewInternal(internals, viewId);
  createViewInternal(internals, url, undefined);
  markChanged(internals);
}

/** 当前活跃视图的 webview 元素；无则返回 undefined。 */
export function activeWebviewOf(runtime: SessionBrowserRuntime): BrowserWebviewElement | undefined {
  const internals = internalsOf(runtime);
  if (internals.runtime.activeTabId === null) return undefined;
  const viewId = internals.viewIdByTabId.get(internals.runtime.activeTabId);
  return viewId === undefined ? undefined : internals.elementByView.get(viewId);
}

/** 当前活跃视图的 viewId；无则返回 undefined。 */
export function activeViewIdOf(runtime: SessionBrowserRuntime): number | undefined {
  const internals = internalsOf(runtime);
  if (internals.runtime.activeTabId === null) return undefined;
  return internals.viewIdByTabId.get(internals.runtime.activeTabId);
}

export function webviewOf(runtime: SessionBrowserRuntime, viewId: number): BrowserWebviewElement | undefined {
  return internalsOf(runtime).elementByView.get(viewId);
}

export function tabIdOfView(runtime: SessionBrowserRuntime, viewId: number): number | undefined {
  return internalsOf(runtime).tabIdByView.get(viewId);
}

/**
 * 把某视图的 webview 元素放入目标容器（面板视口）显示；target 为 null/缺省时
 * 移回 parking host。元素迁移不重建 guest（webContentsId 不变）。
 */
export function displayWebview(runtime: SessionBrowserRuntime, viewId: number, target: HTMLElement | null): void {
  const internals = internalsOf(runtime);
  const element = internals.elementByView.get(viewId);
  if (!element) return;
  const desiredParent = target ?? runtime.container;
  if (element.parentElement === desiredParent) return;
  try {
    desiredParent.appendChild(element);
  } catch {
    // 目标容器已不在 DOM（面板卸载竞态）：留在原处即可。
  }
}

/** 面板错误提示（attach 失败等）。 */
export function clearRuntimeError(runtime: SessionBrowserRuntime): void {
  if (runtime.attachError === null) return;
  runtime.attachError = null;
  markChanged(internalsOf(runtime));
}

function internalsOf(runtime: SessionBrowserRuntime): RuntimeInternals {
  const internals = internalsByKey.get(runtime.sessionKey);
  if (!internals) throw new Error(`browser runtime 不存在: ${runtime.sessionKey}`);
  return internals;
}

function markChanged(internals: RuntimeInternals): void {
  internals.runtime.version += 1;
  const listeners = runtimeListeners.get(internals.runtime.sessionKey);
  if (listeners) {
    for (const listener of [...listeners]) listener();
  }
}

function tabUrlOf(internals: RuntimeInternals, viewId: number): string {
  const tabId = internals.tabIdByView.get(viewId);
  if (tabId === undefined) return "";
  return internals.runtime.tabs.find((tab) => tab.tabId === tabId)?.url ?? "";
}

/** 建 tab 请求：创建带 requestId 的视图并 attach（main 侧 resolve 后自动导航）。 */
function createViewForRequest(internals: RuntimeInternals, requestId: number): void {
  const key = createRequestKey(internals.runtime.sessionKey, requestId);
  const request = pendingCreateRequests.get(key);
  if (!request || internals.handledRequestIds.has(requestId)) return;
  internals.handledRequestIds.add(requestId);
  createViewInternal(internals, request.url, requestId);
}

function createViewInternal(internals: RuntimeInternals, pendingUrl: string, pendingRequestId?: number): void {
  const runtime = internals.runtime;
  const viewId = nextViewId++;
  const record: BrowserViewRecord = {
    viewId,
    crashed: false,
    pendingUrl,
    ...(pendingRequestId !== undefined ? { pendingRequestId } : {}),
    remountEpoch: 1,
  };
  runtime.views.push(record);
  const element = createWebviewElement(runtime);
  internals.elementByView.set(viewId, element);
  bindElementEvents(internals, viewId, element);
  runtime.container.appendChild(element);
  markChanged(internals);
}

function createWebviewElement(runtime: SessionBrowserRuntime): BrowserWebviewElement {
  const element =
    runtimeOptions.createWebviewElement?.() ?? (document.createElement("webview") as unknown as BrowserWebviewElement);
  element.setAttribute("partition", runtime.partition);
  element.setAttribute("src", "about:blank");
  element.setAttribute("allowpopups", "false");
  element.setAttribute("webpreferences", "contextIsolation=yes, nodeIntegration=no, sandbox=yes");
  element.className = "browser-webview";
  return element;
}

function bindElementEvents(internals: RuntimeInternals, viewId: number, element: BrowserWebviewElement): void {
  const onAttach = (): void => attachView(internals, viewId, element, false);
  const onAttachQuiet = (): void => attachView(internals, viewId, element, true);
  const onGone = (): void => handleCrash(internals, viewId, element);
  const onDestroyed = (): void => handleGuestDestroyed(internals, viewId, element);
  element.addEventListener("did-attach", onAttach);
  element.addEventListener("dom-ready", onAttach);
  element.addEventListener("render-process-gone", onGone);
  element.addEventListener("destroyed", onDestroyed);
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (internals.webContentsIdByView.has(viewId)) {
      clearInterval(timer);
      internals.pollTimers.delete(viewId);
      return;
    }
    onAttachQuiet();
    if (attempts >= runtimeOptions.attachPollMaxAttempts) {
      clearInterval(timer);
      internals.pollTimers.delete(viewId);
      if (internals.runtime.attachError === null) {
        internals.runtime.attachError = "webview 未能建立连接（guest 未 attach），请点击「重建视图」重试";
        markChanged(internals);
      }
    }
  }, runtimeOptions.attachPollIntervalMs);
  internals.pollTimers.set(viewId, timer);
  internals.elementCleanups.set(viewId, () => {
    clearInterval(timer);
    element.removeEventListener("did-attach", onAttach);
    element.removeEventListener("dom-ready", onAttach);
    element.removeEventListener("render-process-gone", onGone);
    element.removeEventListener("destroyed", onDestroyed);
    internals.pollTimers.delete(viewId);
  });
}

/**
 * guest webContents 销毁（webview 元素仍在 DOM，Electron 会自动创建新 guest）。
 * 清除本视图的登记：main 已随 destroyed 移除对应 tab，新 guest 的 did-attach 会
 * 走 attachView 重新 attach（重建 tab），否则旧登记会挡住重新 attach 导致视图
 * 与 guest 失联（例如元素在面板视口与 parking host 间移动后 guest 必然重建）。
 */
function handleGuestDestroyed(internals: RuntimeInternals, viewId: number, sourceElement: BrowserWebviewElement): void {
  if (internals.elementByView.get(viewId) !== sourceElement) return;
  const runtime = internals.runtime;
  const tabId = internals.tabIdByView.get(viewId);
  if (tabId !== undefined) {
    internals.viewIdByTabId.delete(tabId);
    internals.tabIdByView.delete(viewId);
  }
  internals.webContentsIdByView.delete(viewId);
  // 标记重建中：Electron 会为仍在 DOM 中的元素自动创建新 guest 并重新 did-attach；
  // 期间 main 侧已移除旧 tab，活跃 tab 回退会触发显示 effect 反复切换可见性，
  // 跳过该视图可避免面板闪烁（见 BrowserPanel 显示 effect）。
  runtime.views = runtime.views.map((view) => (view.viewId === viewId ? { ...view, rebuilding: true } : view));
  markChanged(internals);
}

/** attach：webview did-attach / dom-ready 后把 guest webContentsId + 会话身份交给 main。 */
function attachView(internals: RuntimeInternals, viewId: number, element: BrowserWebviewElement, quiet: boolean): void {
  const runtime = internals.runtime;
  if (
    internals.retiring ||
    internals.webContentsIdByView.has(viewId) ||
    internals.elementByView.get(viewId) !== element
  )
    return;
  let webContentsId: number;
  try {
    webContentsId = element.getWebContentsId();
  } catch {
    if (!quiet) {
      runtime.attachError = "webview 尚未就绪（guest 未 attach），请点击「重建视图」重试";
      markChanged(internals);
    }
    return;
  }
  if (webContentsId <= 0) {
    if (!quiet) {
      runtime.attachError = "webview 尚未就绪（guest 未 attach），请点击「重建视图」重试";
      markChanged(internals);
    }
    return;
  }
  runtime.attachError = null;
  internals.webContentsIdByView.set(viewId, webContentsId);
  const record = runtime.views.find((view) => view.viewId === viewId);
  const requestId = record?.pendingRequestId;
  const isCurrent = (): boolean => internals.elementByView.get(viewId) === element;
  void window.desktop.browser
    .attach(runtime.identity, webContentsId, requestId)
    .then((result) => {
      if (result.ok && requestId !== undefined) {
        acknowledgeCreateTabRequest(runtime.sessionKey, requestId);
        internals.handledRequestIds.delete(requestId);
      }
      if (!isCurrent()) {
        // attach 迟到时主进程可能已登记该 guest；立即释放，不能污染新视图。
        if (result.ok) void window.desktop.browser.detach(runtime.identity, webContentsId);
        return;
      }
      if (!result.ok) {
        runtime.attachError = `浏览器连接失败：${result.error}`;
        discardCreateTabRequest(runtime.sessionKey, requestId);
        if (requestId !== undefined) internals.handledRequestIds.delete(requestId);
        removeViewInternal(internals, viewId);
        markChanged(internals);
        return;
      }
      internals.tabIdByView.set(viewId, result.tab.tabId);
      internals.viewIdByTabId.set(result.tab.tabId, viewId);
      // 请求已由 main 接管，清除 requestId 标记，避免重建时重复走请求路径。
      runtime.views = runtime.views.map((view) =>
        view.viewId === viewId ? { ...view, pendingRequestId: undefined, rebuilding: false } : view,
      );
      const latest = runtime.views.find((view) => view.viewId === viewId);
      if (latest?.pendingUrl && requestId === undefined) {
        void window.desktop.browser.navigate(runtime.identity, result.tab.tabId, latest.pendingUrl);
      }
      markChanged(internals);
    })
    .catch(() => {
      if (!isCurrent()) return;
      discardCreateTabRequest(runtime.sessionKey, requestId);
      if (requestId !== undefined) internals.handledRequestIds.delete(requestId);
      removeViewInternal(internals, viewId);
      runtime.attachError = "浏览器连接失败";
      markChanged(internals);
    });
}

/** 崩溃：detach 让 main 移除 crashed tab，本视图切到占位，记录恢复 URL。 */
function handleCrash(internals: RuntimeInternals, viewId: number, sourceElement: BrowserWebviewElement): void {
  if (internals.elementByView.get(viewId) !== sourceElement) return;
  const runtime = internals.runtime;
  const tabId = internals.tabIdByView.get(viewId);
  let url = "";
  if (tabId !== undefined) {
    url = runtime.tabs.find((tab) => tab.tabId === tabId)?.url ?? "";
    internals.viewIdByTabId.delete(tabId);
    internals.tabIdByView.delete(viewId);
  }
  const webContentsId = internals.webContentsIdByView.get(viewId);
  if (webContentsId !== undefined) {
    internals.webContentsIdByView.delete(viewId);
    void window.desktop.browser.detach(runtime.identity, webContentsId);
  }
  runtime.views = runtime.views.map((view) =>
    view.viewId === viewId ? { ...view, crashed: true, pendingUrl: url } : view,
  );
  markChanged(internals);
}

function removeViewInternal(internals: RuntimeInternals, viewId: number): void {
  const runtime = internals.runtime;
  internals.elementCleanups.get(viewId)?.();
  internals.elementCleanups.delete(viewId);
  const element = internals.elementByView.get(viewId);
  const webContentsId = internals.webContentsIdByView.get(viewId);
  if (webContentsId !== undefined) {
    internals.webContentsIdByView.delete(viewId);
    void window.desktop.browser.detach(runtime.identity, webContentsId);
  }
  const tabId = internals.tabIdByView.get(viewId);
  if (tabId !== undefined) {
    internals.viewIdByTabId.delete(tabId);
    internals.tabIdByView.delete(viewId);
  }
  if (element) {
    try {
      element.remove();
    } catch {
      // 元素可能已不在 DOM。
    }
  }
  internals.elementByView.delete(viewId);
  runtime.views = runtime.views.filter((view) => view.viewId !== viewId);
}

/** 应用 main 状态广播：tabs/activeTab 更新；消失的 tab 对应视图标记重建。 */
function applyStateEvent(internals: RuntimeInternals, event: BrowserStateEvent): void {
  if (internals.retiring) return;
  const runtime = internals.runtime;
  const liveTabIds = new Set(event.tabs.map((tab) => tab.tabId));
  const staleViews: Array<{ viewId: number; pendingUrl: string }> = [];
  for (const [viewId, tabId] of internals.tabIdByView) {
    if (liveTabIds.has(tabId)) continue;
    staleViews.push({ viewId, pendingUrl: runtime.tabs.find((tab) => tab.tabId === tabId)?.url ?? "" });
    internals.tabIdByView.delete(viewId);
    internals.viewIdByTabId.delete(tabId);
    internals.webContentsIdByView.delete(viewId);
  }
  if (staleViews.length > 0) {
    // 对应视图的 guest 已销毁：移除旧元素并按原 URL 重建（重新 attach）。
    for (const stale of staleViews) {
      const record = runtime.views.find((view) => view.viewId === stale.viewId);
      if (!record) continue;
      removeViewInternal(internals, stale.viewId);
      createViewInternal(internals, stale.pendingUrl, undefined);
    }
  }
  runtime.tabs = event.tabs.map((tab) => ({ ...tab }));
  runtime.activeTabId = event.activeTabId;
  markChanged(internals);
}

/** attach 成功后确认请求已完成，避免后续 runtime 重挂载重复创建 view。 */
export function acknowledgeCreateTabRequest(sessionKey: string, requestId: number): void {
  const key = createRequestKey(sessionKey, requestId);
  pendingCreateRequests.delete(key);
  notifiedRequestIds.delete(key);
}

function discardCreateTabRequest(sessionKey: string, requestId: number | undefined): void {
  if (requestId === undefined) return;
  const key = createRequestKey(sessionKey, requestId);
  pendingCreateRequests.delete(key);
  notifiedRequestIds.delete(key);
}
