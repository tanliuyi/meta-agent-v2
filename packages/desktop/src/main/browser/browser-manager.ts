/**
 * 内置浏览器（IAB）主进程服务：按会话隔离的浏览器状态/profile 管理。
 *
 * 每个会话（ThreadWorkerBinding 的 projectId + threadId）拥有独立的
 * Electron partition（`persist:browser-<hash>`）与独立的 tab 注册表、
 * active tab、pending 建 tab 请求、访问历史与标注。所有操作先校验 identity
 * 再访问 tab；Agent 操作不能改变其他会话的 active tab。
 *
 * - tab 注册：renderer 创建 `<webview>` 后上报 guest webContentsId + 会话身份，
 *   main 校验 webContents 属于该会话的 partition 后注册为 tab 并订阅宿主事件。
 * - 状态广播：携带 sessionKey；任何 tab 状态变化后立即调用 `onStateChanged`。
 * - 导航只允许 http/https（file:// 等拒绝）；URL 补全是 renderer 职责。
 * - 设置（allow/block/confirm/download/cdp）全局共享，委托 BrowserSettingsService。
 *
 * 宿主无关：CDP（元素级交互）经 BrowserHostController 扩展实现。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { WebContents } from "electron";
import { BrowserWindow, clipboard, webContents as electronWebContents, Menu, nativeImage, session } from "electron";
import {
  BROWSER_INTERNAL_PAGES,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserAnnotation,
  type BrowserAnnotationBounds,
  type BrowserAnnotationInput,
  type BrowserAnnotationPickResult,
  type BrowserAttachResult,
  type BrowserClipboardResult,
  type BrowserCreateTabRequest,
  type BrowserInspectElementResult,
  type BrowserNavigateResult,
  type BrowserNavigationTargetResult,
  type BrowserOpenTabResult,
  type BrowserScreenshotResult,
  type BrowserSessionIdentity,
  type BrowserSnapshotResult,
  type BrowserStateEvent,
  type BrowserTab,
  browserPartitionFor,
  browserSessionKey,
} from "../../shared/browser-contracts.ts";
import type {
  BrowserSettings,
  BrowserSettingsSnapshot,
  SaveBrowserSettingsInput,
  SaveBrowserSettingsResult,
} from "../../shared/browser-settings-contracts.ts";
import { defaultBrowserSettings } from "../../shared/browser-settings-contracts.ts";
import { checkSiteAccess } from "../../shared/browser-site-policy.ts";
import { type BrowserContextMenuActions, buildBrowserContextMenuTemplate } from "./browser-context-menu.ts";
import {
  type BrowserHostController,
  type BrowserHostEvent,
  StaleReferenceError,
  WebContentsHostController,
  type WebContentsHostControllerOptions,
} from "./browser-host-controller.ts";
import { BrowserSettingsService } from "./browser-settings-service.ts";
import { isBrowserWebviewUrl } from "./browser-webview-policy.ts";

export interface BrowserManagerOptions {
  /** tab 状态变化时广播（携带 sessionKey）；由 index.ts 注入跨窗口推送实现。 */
  onStateChanged?: (event: BrowserStateEvent) => void;
  /** 工具侧建 tab 请求广播（携带 sessionKey）；由 index.ts 注入。 */
  onCreateTabRequest?: (request: BrowserCreateTabRequest) => void;
  /** 服务日志（可选）。 */
  log?: (text: string) => void;
  /** 测试注入：替换宿主创建逻辑。 */
  createHost?: (webContentsId: number, options?: WebContentsHostControllerOptions) => BrowserHostController;
  /** 测试注入：替换 webContents.fromId 解析。 */
  fromWebContentsId?: (webContentsId: number) => WebContents | null;
  /** 测试注入：覆盖设置文件路径。 */
  settingsPath?: string;
}

export type BrowserOperationSource = "user" | "agent" | "popup";

interface TabEntry {
  tabId: number;
  webContentsId: number;
  host: BrowserHostController;
  tab: BrowserTab;
}

interface PendingCreateTab {
  url: string;
  source: BrowserOperationSource;
  resolve: (result: BrowserOpenTabResult) => void;
  reject: (error: Error) => void;
  abort?: AbortSignal;
  onAbort?: () => void;
}

/** 单个会话的浏览器状态：profile（partition）、tabs、历史与标注全部按会话隔离。 */
interface SessionState {
  identity: BrowserSessionIdentity;
  sessionKey: string;
  partition: string;
  browserSession: Electron.Session;
  entries: Map<number, TabEntry>; // tabId -> entry
  byWebContentsId: Map<number, number>; // webContentsId -> tabId
  activeTabId: number | null;
  nextTabId: number;
  pendingCreates: Map<number, PendingCreateTab>;
  /** 访问历史（最近在前，上限 MAX_HISTORY_ENTRIES；仅内存态，供地址栏搜索与 UI）。 */
  history: BrowserHistoryEntry[];
  /** tabId -> 最近记录过的 URL（连续重复导航不重复记录）。 */
  lastHistoryUrlByTab: Map<number, string>;
  /** tabId -> 标注列表（标注模式；仅内存态）。 */
  annotationsByTab: Map<number, BrowserAnnotation[]>;
  onWillDownload: (event: Electron.Event, item: Electron.DownloadItem) => void;
}

/** 内置浏览器主进程服务（main service 入口；内部按 sessionKey 隔离）。 */
export class BrowserManager {
  private readonly options: BrowserManagerOptions;
  private readonly settingsService: BrowserSettingsService;
  private readonly sessions = new Map<string, SessionState>();
  /** 曾经受控注册过的会话身份（retire 后仍保持已知；状态按需重建）。 */
  private readonly knownSessions = new Set<string>();
  /** 当前仍可调用 RPC 的 worker capability -> session identity。 */
  private readonly sessionCapabilities = new Map<string, BrowserSessionIdentity>();
  /** 已经注册过的 identity，用于 clearAllData 覆盖已 retire 的持久分区。 */
  private readonly sessionIdentities = new Map<string, BrowserSessionIdentity>();
  private runtimeSettings: BrowserSettings = defaultBrowserSettings();
  private runtimeSettingsLoaded = false;
  private runtimeSettingsLoadFailed = false;
  private readonly settingsReady: Promise<void>;
  private nextCreateRequestId = 1;
  private disposed = false;

  constructor(userDataDir: string, options: BrowserManagerOptions = {}) {
    this.options = options;
    this.settingsService = new BrowserSettingsService(userDataDir, {
      path: options.settingsPath,
    });
    this.settingsReady = this.refreshRuntimeSettings();
  }

  /** 会话注册：由 thread worker 派生；每次新 worker 注册都会轮换 capability。 */
  registerSession(identity: BrowserSessionIdentity): string {
    const sessionKey = browserSessionKey(identity);
    this.knownSessions.add(sessionKey);
    this.sessionIdentities.set(sessionKey, { ...identity });
    for (const [token, capabilityIdentity] of this.sessionCapabilities) {
      if (browserSessionKey(capabilityIdentity) === sessionKey) this.sessionCapabilities.delete(token);
    }
    const capability = randomBytes(32).toString("hex");
    this.sessionCapabilities.set(capability, { ...identity });
    this.ensureSession(identity);
    return capability;
  }

  /** 解析 worker capability；header 中的 identity 只能作为一致性校验。 */
  resolveSessionCapability(token: string): BrowserSessionIdentity | null {
    const identity = this.sessionCapabilities.get(token);
    if (!identity || !this.knownSessions.has(browserSessionKey(identity))) return null;
    return { ...identity };
  }

  revokeSessionCapability(token: string): void {
    this.sessionCapabilities.delete(token);
  }

  /** RPC 等不可信入口的身份校验：仅接受当前已注册且未退役的会话。 */
  isKnownSession(identity: BrowserSessionIdentity): boolean {
    return this.knownSessions.has(browserSessionKey(identity));
  }

  /** 会话退役：清理该会话的 tabs/pending/历史/标注，并撤销其 RPC 身份。 */
  retireSession(identity: BrowserSessionIdentity): void {
    const sessionKey = browserSessionKey(identity);
    this.knownSessions.delete(sessionKey);
    for (const [token, capabilityIdentity] of this.sessionCapabilities) {
      if (browserSessionKey(capabilityIdentity) === sessionKey) this.sessionCapabilities.delete(token);
    }
    const state = this.sessions.get(sessionKey);
    if (!state) return;
    for (const pending of state.pendingCreates.values()) {
      if (pending.onAbort) pending.abort?.removeEventListener("abort", pending.onAbort);
      pending.reject(new Error("浏览器会话已关闭"));
    }
    state.pendingCreates.clear();
    for (const entry of state.entries.values()) entry.host.dispose();
    state.entries.clear();
    state.byWebContentsId.clear();
    state.activeTabId = null;
    state.history.length = 0;
    state.lastHistoryUrlByTab.clear();
    state.annotationsByTab.clear();
    state.browserSession.off("will-download", state.onWillDownload);
    this.sessions.delete(state.sessionKey);
    this.broadcast(state);
  }

  /** renderer 在 webview attach 后上报 guest webContentsId + 会话身份；重复上报幂等返回已有 tab。
   *  requestId 用于匹配 openTab 发出的建 tab 请求。 */
  async attach(
    identity: BrowserSessionIdentity,
    webContentsId: number,
    requestId?: number,
  ): Promise<BrowserAttachResult> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    if (this.disposed) return { ok: false, error: "浏览器服务已关闭" };

    const existingTabId = state.byWebContentsId.get(webContentsId);
    if (existingTabId !== undefined) {
      const entry = state.entries.get(existingTabId);
      if (entry) return { ok: true, tab: { ...entry.tab } };
    }

    const resolved =
      this.options.fromWebContentsId?.(webContentsId) ?? electronWebContents.fromId(webContentsId) ?? null;
    if (!resolved) return { ok: false, error: `webContents ${webContentsId} 不存在` };
    if (resolved.session !== state.browserSession) {
      return { ok: false, error: `webContents ${webContentsId} 不属于会话浏览器分区` };
    }
    if (!resolved.hostWebContents) {
      return { ok: false, error: `webContents ${webContentsId} 不是浏览器 guest` };
    }
    const initialUrl = resolved.getURL();
    if (!isBrowserWebviewUrl(initialUrl)) {
      return { ok: false, error: `webContents ${webContentsId} 的 URL 不符合浏览器页面要求` };
    }

    if (requestId !== undefined && !state.pendingCreates.has(requestId)) {
      return { ok: false, error: `未知的建 tab 请求 ${requestId}` };
    }

    await this.settingsReady;
    if (this.sessions.get(state.sessionKey) !== state || !this.knownSessions.has(state.sessionKey)) {
      return { ok: false, error: "浏览器会话已关闭" };
    }
    if (requestId !== undefined && !state.pendingCreates.has(requestId)) {
      return { ok: false, error: `未知的建 tab 请求 ${requestId}` };
    }
    const tabId = state.nextTabId++;
    const history = resolved.navigationHistory;
    const tab: BrowserTab = {
      tabId,
      url: initialUrl || "about:blank",
      title: resolved.getTitle() ?? "",
      loading: resolved.isLoading(),
      crashed: false,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      createdAt: Date.now(),
    };
    const hostOptions: WebContentsHostControllerOptions = {
      cdpTimeoutMs: this.runtimeSettings.cdpTimeoutMs,
      maxSnapshotNodes: this.runtimeSettings.maxSnapshotNodes,
      onAgentNavigation: (url, currentUrl, approvedUrl) =>
        this.allowAgentNavigation(state, tabId, url, currentUrl, approvedUrl),
      onPopup: (url) => {
        void this.openTab(state.identity, url, "popup").catch((error: unknown) => {
          this.options.log?.(`browser popup rejected: ${messageOf(error)}`);
        });
      },
      onContextMenu: (event, params) => this.handleContextMenu(state, tabId, resolved, event, params),
    };
    const host =
      this.options.createHost?.(webContentsId, hostOptions) ?? new WebContentsHostController(resolved, hostOptions);
    state.entries.set(tabId, { tabId, webContentsId, host, tab });
    state.byWebContentsId.set(webContentsId, tabId);
    host.onEvent((event) => this.handleHostEvent(state, tabId, event));
    state.activeTabId = tabId;
    this.broadcast(state);

    // 若该 webContents 是对 openTab 建 tab 请求的响应：完成请求并导航目标 URL。
    if (requestId !== undefined) {
      const pending = state.pendingCreates.get(requestId);
      if (pending) {
        state.pendingCreates.delete(requestId);
        if (pending.onAbort) pending.abort?.removeEventListener("abort", pending.onAbort);
        if (pending.abort?.aborted) {
          this.removeEntry(state, tabId);
          pending.resolve({ ok: false, error: "已取消" });
          return { ok: false, error: "已取消" };
        }
        const navigation = await this.navigate(state.identity, tabId, pending.url, pending.source, pending.abort);
        if (!navigation.ok) {
          this.removeEntry(state, tabId);
          pending.resolve({ ok: false, error: navigation.error });
          return { ok: false, error: navigation.error };
        }
        // 导航后回读 entry.tab（navigate 的 did-navigate 事件可能已更新 URL/标题）。
        if (pending.abort?.aborted) {
          this.removeEntry(state, tabId);
          pending.resolve({ ok: false, error: "已取消" });
          return { ok: false, error: "已取消" };
        }
        const current = state.entries.get(tabId);
        pending.resolve({ ok: true, tab: current ? { ...current.tab } : { ...tab } });
      }
    }
    return { ok: true, tab: { ...tab } };
  }

  /** renderer 移除 webview 时注销；幂等。 */
  async detach(identity: BrowserSessionIdentity, webContentsId: number): Promise<void> {
    const state = this.requireSession(identity);
    if (!state) return;
    const tabId = state.byWebContentsId.get(webContentsId);
    if (tabId !== undefined) this.removeEntry(state, tabId);
  }

  /** 切换活跃 tab；不存在时返回 null。 */
  selectTab(identity: BrowserSessionIdentity, tabId: number): BrowserTab | null {
    const state = this.requireSession(identity);
    if (!state) return null;
    const entry = state.entries.get(tabId);
    if (!entry) return null;
    state.activeTabId = tabId;
    this.broadcast(state);
    return { ...entry.tab };
  }

  tabsList(identity: BrowserSessionIdentity): BrowserTab[] {
    const state = this.requireSession(identity);
    if (!state) return [];
    return [...state.entries.values()].map((entry) => ({ ...entry.tab }));
  }

  /** 当前活跃 tab；无 tab 或服务已关闭时返回 null。 */
  activeTab(identity: BrowserSessionIdentity): BrowserTab | null {
    const state = this.requireSession(identity);
    if (!state || state.activeTabId === null) return null;
    const entry = state.entries.get(state.activeTabId);
    return entry ? { ...entry.tab } : null;
  }

  /** 由工具侧发起建 tab：广播建 tab 请求并等待 renderer 创建 webview 后 attach。
   *  不设固定超时（用户确认/渲染器就绪可能较慢）；abort 信号取消时清理 pending 且不留孤儿。 */
  async openTab(
    identity: BrowserSessionIdentity,
    url: string,
    source: BrowserOperationSource = "agent",
    signal?: AbortSignal,
  ): Promise<BrowserOpenTabResult> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    if (this.disposed) return { ok: false, error: "浏览器服务已关闭" };
    const normalized = normalizeNavigateUrl(url);
    if (!normalized) return { ok: false, error: "仅支持 http/https 链接" };
    if (source === "popup") await this.settingsReady;
    if (source === "popup" && checkSiteAccess(this.runtimeSettings, normalized) !== "allowed") {
      return { ok: false, error: `站点 ${new URL(normalized).host} 未列入允许列表，页面弹窗已阻止` };
    }
    if (source === "agent" && this.blockedAgentSiteError(normalized) !== null) {
      return { ok: false, error: this.blockedAgentSiteError(normalized)! };
    }

    const requestId = this.nextCreateRequestId++;
    const request: BrowserCreateTabRequest = { requestId, url: normalized, sessionKey: state.sessionKey };
    if (signal?.aborted) return { ok: false, error: "已取消" };
    return await new Promise<BrowserOpenTabResult>((resolve, reject) => {
      const pending: PendingCreateTab = { url: normalized, source, resolve, reject, abort: signal };
      const onAbort = (): void => {
        state.pendingCreates.delete(requestId);
        if (pending.onAbort) pending.abort?.removeEventListener("abort", pending.onAbort);
        resolve({ ok: false, error: "已取消" });
      };
      pending.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      state.pendingCreates.set(requestId, pending);
      this.options.onCreateTabRequest?.(request);
    });
  }

  /** 结构化页面快照（AX 树简化 + 可交互元素编号 + 可选截图）。 */
  async snapshot(
    identity: BrowserSessionIdentity,
    tabId: number,
    opts: { withScreenshot?: boolean } = {},
    source: BrowserOperationSource = "user",
    signal?: AbortSignal,
  ): Promise<BrowserSnapshotResult> {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent") this.activateAgentTab(state, tabId);
    if (source === "agent") {
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const snapshot = await withAbort(
        () => entry.host.snapshot({ withScreenshot: opts.withScreenshot === true }),
        signal,
        () => entry.host.cancelPendingOperations(),
      );
      return { ok: true, snapshot };
    } catch (error) {
      this.options.log?.(`browser snapshot failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 元素级交互（click/type/scroll），编号来自最近一次 snapshot。 */
  async action(
    identity: BrowserSessionIdentity,
    tabId: number,
    action: BrowserAction,
    source: BrowserOperationSource = "user",
    signal?: AbortSignal,
  ): Promise<BrowserActionResult> {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent" && (action.type === "click" || action.type === "type") && action.target === undefined) {
      return { ok: false, error: "元素引用缺少快照指纹，请重新 browser_snapshot 后再操作", staleRef: true };
    }
    if (source === "agent") this.activateAgentTab(state, tabId);
    if (source === "agent") {
      const expectedUrl = action.type === "scroll" ? action.expectedUrl : action.target?.pageUrl;
      if (expectedUrl !== undefined && !sameBrowserUrl(expectedUrl, entry.tab.url)) {
        return { ok: false, error: "页面已变化，元素引用已失效，请重新获取页面快照", staleRef: true };
      }
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const outcome = await withAbort(
        () => entry.host.performAction(action, { agent: source === "agent" }),
        signal,
        () => entry.host.cancelPendingOperations(),
      );
      return { ok: true, url: outcome.url, title: outcome.title };
    } catch (error) {
      if (error instanceof StaleReferenceError) {
        return { ok: false, error: messageOf(error), staleRef: true };
      }
      this.options.log?.(`browser action failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 读取最近一次 snapshot 中的元素元数据，不刷新编号索引。 */
  inspectElement(identity: BrowserSessionIdentity, tabId: number, elementIndex: number): BrowserInspectElementResult {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    this.activateAgentTab(state, tabId);
    const policyError = this.blockedAgentSiteError(entry.tab.url);
    if (policyError !== null) return { ok: false, error: policyError };
    const node = entry.host.inspectElement(elementIndex);
    return node ? { ok: true, node } : { ok: false, error: "元素编号已失效，请重新获取页面快照", staleRef: true };
  }

  /** 导航到 URL；用户操作支持 http/https 和受限的 Chromium 内置页，Agent 仍只允许 http/https。
   *  loadURL 挂起（连接无响应）时按 NAVIGATE_TIMEOUT_MS 超时返回错误。 */
  async navigate(
    identity: BrowserSessionIdentity,
    tabId: number,
    url: string,
    source: BrowserOperationSource = "user",
    signal?: AbortSignal,
  ): Promise<BrowserNavigateResult> {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const normalized = normalizeNavigateUrl(url) ?? (source === "user" ? normalizeInternalBrowserPage(url) : null);
    if (!normalized) return { ok: false, error: "仅支持 http/https 链接或受支持的 Chromium 内置页面" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "popup" && checkSiteAccess(this.runtimeSettings, normalized) !== "allowed") {
      return { ok: false, error: `站点 ${new URL(normalized).host} 未列入允许列表，页面弹窗已阻止` };
    }
    if (source === "agent") this.activateAgentTab(state, tabId);
    if (source === "agent") {
      const currentPolicyError = this.blockedAgentSiteError(entry.tab.url);
      if (currentPolicyError !== null) return { ok: false, error: currentPolicyError };
      const targetAccess = checkSiteAccess(this.runtimeSettings, normalized);
      if (targetAccess === "blocked") {
        return { ok: false, error: `站点 ${new URL(normalized).host} 已列入禁止访问列表，无法操作` };
      }
    }
    try {
      await withAbort(
        () =>
          withTimeout(
            entry.host.navigate(normalized, { agent: source === "agent", navigationApprovalUrl: normalized }),
            NAVIGATE_TIMEOUT_MS,
            () => entry.host.cancelPendingOperations(),
            `导航超时（${NAVIGATE_TIMEOUT_MS}ms）`,
          ),
        signal,
        () => entry.host.cancelPendingOperations(),
      );
    } catch (error) {
      this.options.log?.(`browser navigate failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
    // did-navigate 事件最终更新 tab.url；此处返回当前状态即可。
    return { ok: true, tab: { ...entry.tab } };
  }

  /** 返回历史动作的目标 URL，Agent 在真正调用 back/forward 前据此完成站点审批。 */
  navigationTarget(
    identity: BrowserSessionIdentity,
    tabId: number,
    direction: "back" | "forward",
  ): BrowserNavigationTargetResult {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    this.activateAgentTab(state, tabId);
    try {
      const history = entry.host.getNavigationState();
      const targetIndex = history.activeIndex + (direction === "back" ? -1 : 1);
      const target = history.entries[targetIndex];
      const current = history.entries[history.activeIndex] ?? { url: entry.tab.url, title: entry.tab.title };
      if (!target) return { ok: false, error: `没有可${direction === "back" ? "后退" : "前进"}的历史记录` };
      return { ok: true, current, target };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 后退；无历史时返回错误。 */
  async goBack(
    identity: BrowserSessionIdentity,
    tabId: number,
    source: BrowserOperationSource = "user",
    navigationApprovalUrl?: string,
    signal?: AbortSignal,
  ): Promise<BrowserNavigateResult> {
    const target = this.navigationTarget(identity, tabId, "back");
    if (!target.ok) return target;
    return this.runHistoryAction(
      identity,
      tabId,
      (host) => host.goBack({ agent: source === "agent", navigationApprovalUrl }),
      source,
      target.target.url,
      navigationApprovalUrl,
      signal,
    );
  }

  /** 前进；无历史时返回错误。 */
  async goForward(
    identity: BrowserSessionIdentity,
    tabId: number,
    source: BrowserOperationSource = "user",
    navigationApprovalUrl?: string,
    signal?: AbortSignal,
  ): Promise<BrowserNavigateResult> {
    const target = this.navigationTarget(identity, tabId, "forward");
    if (!target.ok) return target;
    return this.runHistoryAction(
      identity,
      tabId,
      (host) => host.goForward({ agent: source === "agent", navigationApprovalUrl }),
      source,
      target.target.url,
      navigationApprovalUrl,
      signal,
    );
  }

  async reload(
    identity: BrowserSessionIdentity,
    tabId: number,
    source: BrowserOperationSource = "user",
    signal?: AbortSignal,
  ): Promise<BrowserNavigateResult> {
    return this.runHistoryAction(
      identity,
      tabId,
      (host) => host.reload({ agent: source === "agent" }),
      source,
      undefined,
      undefined,
      signal,
    );
  }

  private async runHistoryAction(
    identity: BrowserSessionIdentity,
    tabId: number,
    run: (host: BrowserHostController) => Promise<void>,
    _source: BrowserOperationSource,
    targetUrl?: string,
    navigationApprovalUrl?: string,
    signal?: AbortSignal,
  ): Promise<BrowserNavigateResult> {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (_source === "agent") this.activateAgentTab(state, tabId);
    if (_source === "agent") {
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
      if (targetUrl !== undefined) {
        const targetPolicyError = this.blockedAgentSiteError(targetUrl);
        if (targetPolicyError !== null) return { ok: false, error: targetPolicyError };
      }
      if (
        navigationApprovalUrl !== undefined &&
        targetUrl !== undefined &&
        !sameBrowserUrl(navigationApprovalUrl, targetUrl)
      ) {
        return { ok: false, error: "历史目标页面已变化，请重新确认后重试" };
      }
    }
    try {
      await withAbort(
        () => run(entry.host),
        signal,
        () => entry.host.cancelPendingOperations(),
      );
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    return { ok: true, tab: { ...entry.tab } };
  }

  /** 截取指定 tab 当前页面 PNG。 */
  async screenshot(
    identity: BrowserSessionIdentity,
    tabId: number,
    source: BrowserOperationSource = "user",
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotResult> {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent") this.activateAgentTab(state, tabId);
    if (source === "agent") {
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const shot = await withAbort(
        () => entry.host.captureScreenshot(),
        signal,
        () => entry.host.cancelPendingOperations(),
      );
      return { ok: true, ...shot };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 截取指定 tab 当前页面 PNG 并写入系统剪贴板。 */
  async copyScreenshot(identity: BrowserSessionIdentity, tabId: number): Promise<BrowserClipboardResult> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    try {
      const shot = await entry.host.captureScreenshot();
      const image = nativeImage.createFromDataURL(shot.dataUrl);
      if (image.isEmpty()) return { ok: false, error: "页面截图为空" };
      clipboard.writeImage(image);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 显示 guest 页面原生 Chromium 右键菜单。 */
  private handleContextMenu(
    state: SessionState,
    tabId: number,
    webContents: WebContents,
    event: Electron.Event,
    params: Electron.ContextMenuParams,
  ): void {
    const entry = state.entries.get(tabId);
    if (!entry || this.disposed) return;

    event.preventDefault();
    const actions: BrowserContextMenuActions = {
      openUrlInNewTab: (url) => {
        void this.openTab(state.identity, url, "user").catch((error: unknown) => {
          this.options.log?.(`browser context menu open failed: ${messageOf(error)}`);
        });
      },
      downloadUrl: (url) => {
        const normalized = normalizeNavigateUrl(url);
        if (!normalized) return;
        try {
          webContents.downloadURL(normalized);
        } catch (error) {
          this.options.log?.(`browser context menu download failed: ${messageOf(error)}`);
        }
      },
      copyText: (text) => clipboard.writeText(text),
      copyImage: (x, y) => webContents.copyImageAt(x, y),
      copyVideoFrame: (x, y) => webContents.copyVideoFrameAt(x, y),
      replaceMisspelling: (word) => webContents.replaceMisspelling(word),
      addWordToDictionary: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
      undo: () => webContents.undo(),
      redo: () => webContents.redo(),
      cut: () => webContents.cut(),
      copy: () => webContents.copy(),
      paste: () => webContents.paste(),
      pasteAndMatchStyle: () => webContents.pasteAndMatchStyle(),
      delete: () => webContents.delete(),
      selectAll: () => webContents.selectAll(),
      goBack: () => {
        void this.goBack(state.identity, tabId, "user").catch((error: unknown) => {
          this.options.log?.(`browser context menu back failed: ${messageOf(error)}`);
        });
      },
      goForward: () => {
        void this.goForward(state.identity, tabId, "user").catch((error: unknown) => {
          this.options.log?.(`browser context menu forward failed: ${messageOf(error)}`);
        });
      },
      reload: () => {
        void this.reload(state.identity, tabId, "user").catch((error: unknown) => {
          this.options.log?.(`browser context menu reload failed: ${messageOf(error)}`);
        });
      },
      print: () => {
        try {
          webContents.print({ printBackground: true }, (success, failureReason) => {
            if (!success) this.options.log?.(`browser context menu print failed: ${failureReason}`);
          });
        } catch (error) {
          this.options.log?.(`browser context menu print failed: ${messageOf(error)}`);
        }
      },
      inspect: (x, y) => {
        try {
          webContents.inspectElement(x, y);
        } catch (error) {
          this.options.log?.(`browser context menu inspect failed: ${messageOf(error)}`);
        }
      },
      canGoBack: entry.tab.canGoBack,
      canGoForward: entry.tab.canGoForward,
    };

    try {
      const menu = Menu.buildFromTemplate(buildBrowserContextMenuTemplate(params, actions));
      const owner = webContents.hostWebContents ?? webContents;
      menu.popup({
        window: BrowserWindow.fromWebContents(owner) ?? undefined,
        frame: params.frame ?? undefined,
        sourceType: params.menuSourceType,
      });
    } catch (error) {
      this.options.log?.(`browser context menu failed: ${messageOf(error)}`);
    }
  }

  /** 清除指定会话分区数据（cookie/缓存/登录态），即使当前没有已注册 tab。 */
  async clearSessionData(identity: BrowserSessionIdentity, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const state = this.requireSession(identity);
    if (!state) return;
    await Promise.all([state.browserSession.clearStorageData(), state.browserSession.clearCache()]);
  }

  /** 清除全部已注册过的会话分区数据（设置页入口）。 */
  async clearAllData(): Promise<void> {
    await Promise.all(
      [...this.sessionIdentities.values()].map(async (identity) => {
        const state = this.sessions.get(browserSessionKey(identity));
        const browserSession = state?.browserSession ?? session.fromPartition(browserPartitionFor(identity));
        await Promise.all([browserSession.clearStorageData(), browserSession.clearCache()]);
      }),
    );
  }

  /** 访问历史（最近在前）；仅用户 UI 用，Agent 侧不可见（规范 §10.5）。 */
  browserHistory(identity: BrowserSessionIdentity): BrowserHistoryEntry[] {
    const state = this.requireSession(identity);
    if (!state) return [];
    return state.history.map((entry) => ({ ...entry }));
  }

  /** 取视口坐标处元素（标注模式）：生成选择器与 bounds。 */
  async pickAnnotationTarget(
    identity: BrowserSessionIdentity,
    tabId: number,
    x: number,
    y: number,
  ): Promise<BrowserAnnotationPickResult> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    try {
      return await entry.host.pickElement(x, y);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 添加标注；返回完整标注对象。 */
  async addAnnotation(
    identity: BrowserSessionIdentity,
    tabId: number,
    input: BrowserAnnotationInput,
  ): Promise<BrowserAnnotation | null> {
    const state = this.requireSession(identity);
    if (!state) return null;
    const entry = state.entries.get(tabId);
    if (!entry) return null;
    const annotation: BrowserAnnotation = {
      id: randomUUID(),
      tabId,
      selector: input.selector,
      tag: input.tag,
      bounds: { ...input.bounds },
      text: input.text,
      createdAt: Date.now(),
    };
    const list = state.annotationsByTab.get(tabId) ?? [];
    list.push(annotation);
    state.annotationsByTab.set(tabId, list);
    return { ...annotation };
  }

  /** 指定 tab 的标注列表（最近创建在前）。 */
  listAnnotations(identity: BrowserSessionIdentity, tabId: number): BrowserAnnotation[] {
    const state = this.requireSession(identity);
    if (!state) return [];
    return (state.annotationsByTab.get(tabId) ?? [])
      .slice()
      .reverse()
      .map((annotation) => ({ ...annotation, bounds: { ...annotation.bounds } }));
  }

  /** 删除标注；不存在时静默。 */
  async removeAnnotation(identity: BrowserSessionIdentity, tabId: number, id: string): Promise<void> {
    const state = this.requireSession(identity);
    if (!state) return;
    const list = state.annotationsByTab.get(tabId);
    if (!list) return;
    const next = list.filter((annotation) => annotation.id !== id);
    if (next.length === 0) state.annotationsByTab.delete(tabId);
    else state.annotationsByTab.set(tabId, next);
  }

  /** 按选择器重新解析标注 bounds（导航/重绘后 overlay 重定位）；元素消失返回 null。 */
  async resolveAnnotationBounds(
    identity: BrowserSessionIdentity,
    tabId: number,
    id: string,
  ): Promise<BrowserAnnotationBounds | null> {
    const state = this.requireSession(identity);
    if (!state) return null;
    const annotation = (state.annotationsByTab.get(tabId) ?? []).find((item) => item.id === id);
    if (!annotation) return null;
    const entry = state.entries.get(tabId);
    if (!entry || entry.tab.crashed) return null;
    try {
      return await entry.host.resolveSelectorBounds(annotation.selector);
    } catch {
      return null;
    }
  }

  async getSettingsSnapshot(): Promise<BrowserSettingsSnapshot> {
    const snapshot = await this.settingsService.getSnapshot();
    this.runtimeSettings = snapshot.settings;
    this.runtimeSettingsLoaded = true;
    this.runtimeSettingsLoadFailed = false;
    return snapshot;
  }

  async saveSettings(input: SaveBrowserSettingsInput): Promise<SaveBrowserSettingsResult> {
    const result = await this.settingsService.saveConfig(input);
    if (result.status === "saved") {
      this.runtimeSettings = result.snapshot.settings;
      this.runtimeSettingsLoaded = true;
      this.runtimeSettingsLoadFailed = false;
      const options = {
        cdpTimeoutMs: this.runtimeSettings.cdpTimeoutMs,
        maxSnapshotNodes: this.runtimeSettings.maxSnapshotNodes,
      };
      for (const state of this.sessions.values()) {
        for (const entry of state.entries.values()) entry.host.updateSettings(options);
      }
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.sessions.values()) {
      state.browserSession.off("will-download", state.onWillDownload);
      for (const pending of state.pendingCreates.values()) {
        if (pending.onAbort) pending.abort?.removeEventListener("abort", pending.onAbort);
        pending.reject(new Error("浏览器服务已关闭"));
      }
      state.pendingCreates.clear();
      for (const entry of state.entries.values()) entry.host.dispose();
      state.entries.clear();
      state.byWebContentsId.clear();
      state.activeTabId = null;
    }
    this.sessions.clear();
    this.sessionCapabilities.clear();
  }

  /** 会话状态（不存在则创建）。IPC（renderer）路径使用：renderer 是受信应用代码。 */
  private ensureSession(identity: BrowserSessionIdentity): SessionState {
    const sessionKey = browserSessionKey(identity);
    this.knownSessions.add(sessionKey);
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    const partition = browserPartitionFor(identity);
    const browserSession = session.fromPartition(partition);
    // 分区权限默认全部拒绝（spec §10）：未设置 handler 时 Electron 默认放行
    // 权限请求，恶意页面可静默取得摄像头/麦克风/地理位置等。
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
      const directory = this.runtimeSettings.downloadDirectory;
      if (!directory) return;
      const filename = basename(item.getFilename());
      if (filename.length === 0) return;
      item.setSavePath(join(directory, filename));
    };
    browserSession.on("will-download", onWillDownload);
    const state: SessionState = {
      identity: { ...identity },
      sessionKey,
      partition,
      browserSession,
      entries: new Map(),
      byWebContentsId: new Map(),
      activeTabId: null,
      nextTabId: 1,
      pendingCreates: new Map(),
      history: [],
      lastHistoryUrlByTab: new Map(),
      annotationsByTab: new Map(),
      onWillDownload,
    };
    this.sessions.set(sessionKey, state);
    return state;
  }

  /** 会话状态（仅已注册会话；RPC/sidecar 路径使用，缺失即拒绝）。 */
  private requireSession(identity: BrowserSessionIdentity): SessionState | null {
    if (this.disposed) return null;
    return this.sessions.get(browserSessionKey(identity)) ?? null;
  }

  private activateAgentTab(state: SessionState, tabId: number): void {
    if (state.activeTabId === tabId) return;
    state.activeTabId = tabId;
    this.broadcast(state);
  }

  private handleHostEvent(state: SessionState, tabId: number, event: BrowserHostEvent): void {
    const entry = state.entries.get(tabId);
    if (!entry || this.disposed) return;
    switch (event.type) {
      case "navigated":
        entry.tab.url = event.url;
        entry.tab.canGoBack = event.canGoBack;
        entry.tab.canGoForward = event.canGoForward;
        entry.tab.crashed = false;
        entry.tab.loadError = undefined;
        this.recordHistory(state, tabId, event.url, entry.tab.title);
        break;
      case "navigated-in-page":
        entry.tab.url = event.url;
        entry.tab.loadError = undefined;
        try {
          const navigation = entry.host.getNavigationState();
          entry.tab.canGoBack = navigation.activeIndex > 0;
          entry.tab.canGoForward = navigation.activeIndex < navigation.entries.length - 1;
        } catch {
          // history API 查询失败时保留上一份按钮状态。
        }
        break;
      case "title-updated":
        entry.tab.title = event.title;
        // 同步历史中该 tab 最后一条同 URL 记录的标题（导航后标题异步到达）。
        if (state.lastHistoryUrlByTab.get(tabId) === entry.tab.url) {
          const historyIndex = state.history.findIndex((item) => item.url === entry.tab.url);
          if (historyIndex !== -1) {
            state.history[historyIndex] = { ...state.history[historyIndex]!, title: event.title };
          }
        }
        break;
      case "loading-changed":
        entry.tab.loading = event.loading;
        if (event.loading) entry.tab.loadError = undefined;
        break;
      case "load-failed":
        entry.tab.loading = false;
        entry.tab.loadError = describeLoadError(event.code, event.description, event.url);
        break;
      case "crashed":
        entry.tab.crashed = true;
        entry.tab.loading = false;
        break;
      case "destroyed":
        // guest webContents 已销毁：从注册表移除（webview 需由 renderer 重建后重新 attach）。
        this.removeEntry(state, tabId);
        return;
    }
    this.broadcast(state);
  }

  private removeEntry(state: SessionState, tabId: number): void {
    const entry = state.entries.get(tabId);
    if (!entry) return;
    state.entries.delete(tabId);
    state.byWebContentsId.delete(entry.webContentsId);
    state.lastHistoryUrlByTab.delete(tabId);
    state.annotationsByTab.delete(tabId);
    if (state.activeTabId === tabId) {
      state.activeTabId = [...state.entries.keys()][0] ?? null;
    }
    entry.host.dispose();
    this.broadcast(state);
  }

  /** 记录访问历史：同一 tab 重复导航同 URL 不重复；会话内同 URL 合并并提前。 */
  private recordHistory(state: SessionState, tabId: number, url: string, title: string): void {
    if (state.lastHistoryUrlByTab.get(tabId) === url) return;
    state.lastHistoryUrlByTab.set(tabId, url);
    const existing = state.history.findIndex((entry) => entry.url === url);
    if (existing !== -1) {
      const current = state.history.splice(existing, 1)[0]!;
      state.history.unshift({ url, title: title || current.title, timestamp: Date.now() });
      return;
    }
    state.history.unshift({ url, title, timestamp: Date.now() });
    if (state.history.length > MAX_HISTORY_ENTRIES) state.history.length = MAX_HISTORY_ENTRIES;
  }

  private async refreshRuntimeSettings(): Promise<void> {
    try {
      this.runtimeSettings = (await this.settingsService.getSnapshot()).settings;
    } catch (error) {
      this.runtimeSettingsLoadFailed = true;
      this.options.log?.(`browser settings load failed: ${messageOf(error)}`);
    } finally {
      this.runtimeSettingsLoaded = true;
    }
  }

  private blockedAgentSiteError(url: string): string | null {
    if (!this.runtimeSettingsLoaded) return null;
    if (this.runtimeSettingsLoadFailed) return "无法读取浏览器访问策略，请确认浏览器服务正常后重试";
    if (checkSiteAccess(this.runtimeSettings, url) !== "blocked") return null;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep raw URL in the error
    }
    return `站点 ${host} 已列入禁止访问列表，无法操作`;
  }

  /** Agent 动作触发页面导航时的同步守卫；用户地址栏导航不经过此回调。 */
  private allowAgentNavigation(
    _state: SessionState,
    tabId: number,
    url: string,
    currentUrl: string,
    approvedUrl?: string,
  ): boolean {
    const target = parseHttpUrl(url);
    const current = parseHttpUrl(currentUrl);
    if (!target) return false;
    if (checkSiteAccess(this.runtimeSettings, target.href) === "blocked") return false;
    if (checkSiteAccess(this.runtimeSettings, target.href) === "allowed") return true;
    const approved = approvedUrl ? parseHttpUrl(approvedUrl) : null;
    if (approved && approved.href === target.href) return true;
    if (current && current.host === target.host) return true;
    this.options.log?.(`blocked agent navigation for tab ${tabId}: ${target.href}`);
    return false;
  }

  private broadcast(state: SessionState): void {
    if (this.disposed) return;
    this.options.onStateChanged?.({
      sessionKey: state.sessionKey,
      tabs: [...state.entries.values()].map((entry) => ({ ...entry.tab })),
      activeTabId: state.activeTabId,
    });
  }
}

/** 访问历史上限（内存态，超出丢弃最旧）。 */
const MAX_HISTORY_ENTRIES = 200;

/** loadURL 挂起保护（连接无响应时避免工具/地址栏一直等待）。 */
const NAVIGATE_TIMEOUT_MS = 30_000;

/** 把 did-fail-load 错误码转成用户可读文案。 */
function describeLoadError(code: number, description: string, url: string): string {
  const known = new Map<number, string>([
    [-105, "域名解析失败（DNS）"],
    [-106, "无法连接服务器"],
    [-102, "连接被拒绝"],
    [-118, "连接超时"],
    [-200, "网络连接已断开"],
    [-201, "网络访问被拒绝（可能需要代理）"],
    [-202, "无法解析代理服务器"],
    [-130, "证书错误（HTTPS）"],
    [-113, "TLS 连接失败"],
    [-137, "连接已重置"],
    [-7, "加载超时"],
  ]);
  const label = known.get(code);
  return `${label ?? `网络错误 ${code}`}（${description}）：${url}`;
}

/** 带超时的 Promise 包装；超时会触发取消回调并返回结构化错误。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (signal === undefined) return operation();
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new Error("已取消"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      onAbort();
      cleanup();
      reject(new Error("已取消"));
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    signal.addEventListener("abort", abort, { once: true });
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/** 一条访问历史记录（用户 UI 用，Agent 不可见）。 */
export interface BrowserHistoryEntry {
  url: string;
  title: string;
  timestamp: number;
}

function sameBrowserUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function normalizeNavigateUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const trimmed = raw.trim();
  // 无协议输入补 https://（工具描述承诺；renderer 地址栏另有补全逻辑）。
  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    candidate = `https://${trimmed}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

function normalizeInternalBrowserPage(raw: string): string | null {
  return Object.values(BROWSER_INTERNAL_PAGES).find((page) => page === raw) ?? null;
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
