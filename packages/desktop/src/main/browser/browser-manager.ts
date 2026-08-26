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
import {
  BrowserWindow,
  ClipboardItem,
  clipboard,
  webContents as electronWebContents,
  Menu,
  nativeImage,
  session,
  shell,
} from "electron";
import {
  type BrowserAction,
  type BrowserActionResult,
  type BrowserAnnotation,
  type BrowserAnnotationBounds,
  type BrowserAnnotationInput,
  type BrowserAnnotationPickResult,
  type BrowserAnnotationUpdateInput,
  type BrowserAttachResult,
  type BrowserClipboardResult,
  type BrowserCloseTabRequest,
  type BrowserConsoleEntry,
  type BrowserCreateTabRequest,
  type BrowserEvaluateResult,
  type BrowserInspectElementResult,
  type BrowserNavigateResult,
  type BrowserNavigationTargetResult,
  type BrowserOpenTabResult,
  type BrowserPendingDialog,
  type BrowserScreenshotResult,
  type BrowserSessionIdentity,
  type BrowserSnapshotResult,
  type BrowserStateEvent,
  type BrowserTab,
  browserPartitionFor,
  browserSessionKey,
  sameBrowserUrl,
} from "../../shared/browser-contracts.ts";
import type {
  BrowserContactInput,
  BrowserDataMutateResult,
  BrowserDataSnapshot,
  BrowserPasswordInput,
  BrowserPasswordOffer,
  BrowserPasswordOfferResolveResult,
  BrowserPermissionKind,
  BrowserPermissionValue,
  BrowserSitePermission,
  BrowserSitePermissionInput,
  ContactProfile,
  SavedPassword,
} from "../../shared/browser-data-contracts.ts";
import { parseBrowserInternalPage } from "../../shared/browser-internal-contracts.ts";
import type {
  BrowserSettings,
  BrowserSettingsSnapshot,
  SaveBrowserSettingsInput,
  SaveBrowserSettingsResult,
} from "../../shared/browser-settings-contracts.ts";
import { defaultBrowserSettings } from "../../shared/browser-settings-contracts.ts";
import { checkSiteAccess, defaultSiteApproval, siteMatches } from "../../shared/browser-site-policy.ts";
import { type BrowserContextMenuActions, buildBrowserContextMenuTemplate } from "./browser-context-menu.ts";
import type { BrowserDataService } from "./browser-data-service.ts";
import {
  BROWSER_PASSWORD_OFFER_BINDING,
  BROWSER_PASSWORD_WATCHER_SCRIPT,
  buildBrowserContactAutofillScript,
  buildBrowserPasswordAutofillScript,
} from "./browser-form-scripts.ts";
import {
  type BrowserHostController,
  type BrowserHostEvent,
  StaleReferenceError,
  WebContentsHostController,
  type WebContentsHostControllerOptions,
} from "./browser-host-controller.ts";
import { BrowserSettingsService } from "./browser-settings-service.ts";
import { isBrowserInternalWebContents, isBrowserWebviewUrl } from "./browser-webview-policy.ts";

export interface BrowserManagerOptions {
  /** tab 状态变化时广播（携带 sessionKey）；由 index.ts 注入跨窗口推送实现。 */
  onStateChanged?: (event: BrowserStateEvent) => void;
  /** 工具侧建 tab 请求广播（携带 sessionKey）；由 index.ts 注入。 */
  onCreateTabRequest?: (request: BrowserCreateTabRequest) => void;
  /** 工具 browser.close 触发：请求 renderer 删除对应视图（随后 renderer detach 完成移除）。 */
  onCloseTabRequest?: (request: BrowserCloseTabRequest) => void;
  /** 服务日志（可选）。 */
  log?: (text: string) => void;
  /** 测试注入：替换宿主创建逻辑。 */
  createHost?: (webContentsId: number, options?: WebContentsHostControllerOptions) => BrowserHostController;
  /** 测试注入：替换 webContents.fromId 解析。 */
  fromWebContentsId?: (webContentsId: number) => WebContents | null;
  /** 测试注入：覆盖设置文件路径。 */
  settingsPath?: string;
  /** 浏览器用户数据服务（历史/下载/联系人/密码/网站设置持久化）。 */
  data?: BrowserDataService;
  /** 新会话 partition 创建后安装 browser:// 资源 handler。 */
  onSessionCreated?: (browserSession: Electron.Session) => void;
  /** 密码保存请求（不含密码正文）；由 index.ts 定向推送到所属 renderer。 */
  onPasswordOffer?: (offer: BrowserPasswordOffer, ownerWebContentsId: number) => void;
}

export type BrowserOperationSource = "user" | "agent" | "popup";

interface TabEntry {
  tabId: number;
  webContentsId: number;
  ownerWebContentsId: number;
  host: BrowserHostController;
  tab: BrowserTab;
  /** 是否为带内部 WebUI preload 的特权 guest；其生命周期内只能加载已知 browser:// 页面。 */
  internalPage: boolean;
  /** 移除 guest 事件监听（表单检测/填充）。 */
  disposeGuestListeners: () => void;
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
  /** 每个会话当前持有其浏览器状态的 renderer（webContentsId）集合。 */
  private readonly sessionOwners = new Map<string, Set<number>>();
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
  /** 网站设置覆盖缓存（kind -> site -> value）；权限 handler 同步读取。 */
  private sitePermissionOverrides = new Map<BrowserPermissionKind, Map<string, BrowserPermissionValue>>();
  /** 持久化网站设置加载失败或尚未完成时，权限 handler 必须 fail-closed。 */
  private sitePermissionOverridesLoaded = false;
  private sitePermissionLoadGeneration = 0;
  /** 未决密码保存请求（offerId -> renderer 归属 + 会话身份 + 凭据）；resolve 时校验归属。 */
  private readonly passwordOffers = new Map<
    string,
    {
      ownerWebContentsId: number;
      identity: BrowserSessionIdentity;
      origin: string;
      username: string;
      password: string;
    }
  >();
  private readonly passwordOfferTimers = new Map<string, NodeJS.Timeout>();

  constructor(userDataDir: string, options: BrowserManagerOptions = {}) {
    this.options = options;
    this.settingsService = new BrowserSettingsService(userDataDir, {
      path: options.settingsPath,
    });
    this.settingsReady = this.refreshRuntimeSettings();
    void this.loadSitePermissionOverrides();
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
    const identity = this.sessionCapabilities.get(token);
    this.sessionCapabilities.delete(token);
    if (!identity) return;
    this.destroySessionIfUnowned(browserSessionKey(identity));
  }

  /** RPC 等不可信入口的身份校验：仅接受当前已注册且未退役的会话。 */
  isKnownSession(identity: BrowserSessionIdentity): boolean {
    return this.knownSessions.has(browserSessionKey(identity));
  }

  /** 会话退役：只释放该 renderer 的持有权；全部持有者释放后才销毁会话状态。 */
  retireSession(identity: BrowserSessionIdentity, ownerWebContentsId: number): void {
    const sessionKey = browserSessionKey(identity);
    const owners = this.sessionOwners.get(sessionKey);
    if (owners) {
      owners.delete(ownerWebContentsId);
      if (owners.size > 0) return;
      this.sessionOwners.delete(sessionKey);
    }
    this.destroySessionIfUnowned(sessionKey);
  }

  /**
   * renderer 声明持有某会话的浏览器状态（创建/挂载 browser runtime 时调用）。
   * 幂等：同一 renderer 重复声明不会重复计数。
   */
  acquireSession(identity: BrowserSessionIdentity, ownerWebContentsId: number): void {
    const state = this.ensureSession(identity);
    const owners = this.sessionOwners.get(state.sessionKey) ?? new Set<number>();
    owners.add(ownerWebContentsId);
    this.sessionOwners.set(state.sessionKey, owners);
  }

  /** renderer 退出时释放其持有的全部会话，并销毁失去最后 owner 的状态。 */
  releaseOwner(ownerWebContentsId: number): void {
    for (const [sessionKey, owners] of this.sessionOwners) {
      if (!owners.delete(ownerWebContentsId)) continue;
      if (owners.size > 0) continue;
      this.sessionOwners.delete(sessionKey);
      this.destroySessionIfUnowned(sessionKey);
    }
  }

  /** renderer owner 与 worker capability 都释放后才真正销毁会话。 */
  private destroySessionIfUnowned(sessionKey: string): void {
    if (this.sessionOwners.has(sessionKey)) return;
    for (const identity of this.sessionCapabilities.values()) {
      if (browserSessionKey(identity) === sessionKey) return;
    }
    this.destroySession(sessionKey);
  }

  /** 全部持有者释放后由 retireSession 调用：销毁 tabs/pending/历史/标注并撤销 RPC 身份。 */
  private destroySession(sessionKey: string): void {
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
    for (const entry of state.entries.values()) {
      entry.disposeGuestListeners();
      entry.host.dispose();
    }
    for (const [offerId, offer] of this.passwordOffers) {
      if (browserSessionKey(offer.identity) !== sessionKey) continue;
      const timer = this.passwordOfferTimers.get(offerId);
      if (timer) clearTimeout(timer);
      this.passwordOfferTimers.delete(offerId);
      this.passwordOffers.delete(offerId);
    }
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
    // did-attach 触发时 guest 的初始 URL 可能尚未提交（getURL() 返回空串）；
    // webview 元素始终以 about:blank 起步，此时视为 about:blank 放行，否则
    // attach 必然失败导致 renderer 移除 webview、openTab 请求永远挂起。
    const initialUrl = resolved.getURL();
    const effectiveInitialUrl = initialUrl.length === 0 ? "about:blank" : initialUrl;
    if (!isBrowserWebviewUrl(effectiveInitialUrl)) {
      return { ok: false, error: `webContents ${webContentsId} 的 URL 不符合浏览器页面要求` };
    }
    const isInternalPageGuest =
      parseBrowserInternalPage(effectiveInitialUrl) !== null || isBrowserInternalWebContents(webContentsId);

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
      ...(isInternalPageGuest ? { allowNavigation: (url: string) => parseBrowserInternalPage(url) !== null } : {}),
      onPopup: (url) => {
        void this.openTab(state.identity, url, "popup").catch((error: unknown) => {
          this.options.log?.(`browser popup rejected: ${messageOf(error)}`);
        });
      },
      onContextMenu: (event, params) => this.handleContextMenu(state, tabId, resolved, event, params),
      onRuntimeBinding: (name, payload) => {
        if (name === BROWSER_PASSWORD_OFFER_BINDING) this.handlePasswordOfferMessage(state, tabId, payload);
      },
    };
    const host =
      this.options.createHost?.(webContentsId, hostOptions) ?? new WebContentsHostController(resolved, hostOptions);
    const onDidFinishLoad = (): void => {
      if (resolved.isDestroyed() || parseBrowserInternalPage(resolved.getURL()) !== null) return;
      void this.injectFormScripts(resolved, host);
    };
    resolved.on("did-finish-load", onDidFinishLoad);
    state.entries.set(tabId, {
      tabId,
      webContentsId,
      ownerWebContentsId: resolved.hostWebContents.id,
      host,
      tab,
      internalPage: isInternalPageGuest,
      disposeGuestListeners: () => {
        if (!resolved.isDestroyed()) {
          resolved.removeListener("did-finish-load", onDidFinishLoad);
        }
      },
    });
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

  /** 工具关闭标签页：广播 close 请求由 renderer 删除视图（视图 detach 时本侧移除 entry）。 */
  async closeTab(
    identity: BrowserSessionIdentity,
    tabId: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    this.options.onCloseTabRequest?.({ sessionKey: state.sessionKey, tabId });
    return { ok: true };
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
    if (source === "agent") {
      await this.settingsReady;
      const settingsError = this.agentSettingsError();
      if (settingsError !== null) return { ok: false, error: settingsError };
    }
    const normalized = normalizeNavigateUrl(url);
    if (!normalized) return { ok: false, error: "仅支持 http/https 链接" };
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
    if (source === "agent") {
      await this.settingsReady;
      const settingsError = this.agentSettingsError();
      if (settingsError !== null) return { ok: false, error: settingsError };
      this.activateAgentTab(state, tabId);
    }
    if (source === "agent") {
      const policyError = this.blockedAgentTabError(entry);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const snapshot = await withAbort(
        () =>
          entry.host.snapshot({
            withScreenshot: opts.withScreenshot === true && this.runtimeSettings.includeScreenshots,
          }),
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
    if (source === "agent") {
      await this.settingsReady;
      const settingsError = this.agentSettingsError();
      if (settingsError !== null) return { ok: false, error: settingsError };
      this.activateAgentTab(state, tabId);
    }
    if (source === "agent") {
      const expectedUrl = action.type === "scroll" ? action.expectedUrl : action.target?.pageUrl;
      if (expectedUrl !== undefined && !sameBrowserUrl(expectedUrl, entry.tab.url)) {
        return { ok: false, error: "页面已变化，元素引用已失效，请重新获取页面快照", staleRef: true };
      }
      const policyError = this.blockedAgentTabError(entry);
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
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    const node = entry.host.inspectElement(elementIndex);
    return node ? { ok: true, node } : { ok: false, error: "元素编号已失效，请重新获取页面快照", staleRef: true };
  }

  /** 导航到 URL；仅支持 http/https，browser:// 页面由 renderer 以受信 webview 加载。
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
    if (source === "agent") {
      await this.settingsReady;
      const settingsError = this.agentSettingsError();
      if (settingsError !== null) return { ok: false, error: settingsError };
    }
    const normalized = normalizeNavigateUrl(url);
    if (!normalized) return { ok: false, error: "仅支持 http/https 链接" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.internalPage || parseBrowserInternalPage(entry.tab.url) !== null) {
      return { ok: false, error: "browser:// 标签需要重建 webview 后才能导航到网站" };
    }
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent") this.activateAgentTab(state, tabId);
    if (source === "agent") {
      const currentPolicyError = this.blockedAgentTabError(entry);
      if (currentPolicyError !== null) return { ok: false, error: currentPolicyError };
      const targetAccess = checkSiteAccess(this.runtimeSettings, normalized);
      if (targetAccess === "blocked") {
        return { ok: false, error: `站点 ${new URL(normalized).host} 已列入禁止访问列表，无法操作` };
      }
    }
    entry.tab.loadError = undefined;
    this.broadcast(state);
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
      return { ok: false, error: messageOf(error), loadError: entry.tab.loadError };
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
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
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
    if (_source === "agent") {
      await this.settingsReady;
      const settingsError = this.agentSettingsError();
      if (settingsError !== null) return { ok: false, error: settingsError };
      this.activateAgentTab(state, tabId);
    }
    if (_source === "agent") {
      const policyError = this.blockedAgentTabError(entry);
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
    fullPage = false,
  ): Promise<BrowserScreenshotResult> {
    if (signal?.aborted) return { ok: false, error: "已取消" };
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent") {
      await this.settingsReady;
      const settingsError = this.agentSettingsError();
      if (settingsError !== null) return { ok: false, error: settingsError };
      this.activateAgentTab(state, tabId);
    }
    if (source === "agent") {
      const policyError = this.blockedAgentTabError(entry);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const shot = await withAbort(
        () => entry.host.captureScreenshot({ fullPage }),
        signal,
        () => entry.host.cancelPendingOperations(),
      );
      return { ok: true, ...shot };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 读取页面 console 日志（对齐 Codex tab_dev_logs；拉取即清空）。 */
  async readConsoleLogs(
    identity: BrowserSessionIdentity,
    tabId: number,
    options: { filter?: string; levels?: BrowserConsoleEntry["level"][]; limit?: number } = {},
  ): Promise<{ ok: true; logs: BrowserConsoleEntry[] } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      const logs = await entry.host.readConsoleLogs(options);
      return { ok: true, logs };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 当前挂起的 JS 对话框（对齐 Codex tab_get_js_dialog）。 */
  async getPendingDialog(
    identity: BrowserSessionIdentity,
    tabId: number,
  ): Promise<{ ok: true; dialog: BrowserPendingDialog | null } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      return { ok: true, dialog: entry.host.getPendingDialog() };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 响应挂起的 JS 对话框（对齐 Codex tab_handle_js_dialog）。 */
  async handleDialog(
    identity: BrowserSessionIdentity,
    tabId: number,
    action: "accept" | "dismiss",
    promptText?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    try {
      await entry.host.handleDialog(action, promptText);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 在页面上下文执行 JS（对齐 Codex PlaywrightEvaluate）。 */
  async evaluate(
    identity: BrowserSessionIdentity,
    tabId: number,
    expression: string,
  ): Promise<{ ok: true; result: BrowserEvaluateResult } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      const result = await entry.host.evaluate(expression);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 按键（对齐 Codex CuaKeypress）。 */
  async pressKey(
    identity: BrowserSessionIdentity,
    tabId: number,
    keySequence: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.pressKey(keySequence);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 等待页面条件（对齐 Codex waitFor*）。 */
  async waitFor(
    identity: BrowserSessionIdentity,
    tabId: number,
    options: { state?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number; url?: string } = {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.waitFor(options);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 读取缓冲的 CDP 事件（对齐 Codex cdp.readEvents）。 */
  async readCdpEvents(
    identity: BrowserSessionIdentity,
    tabId: number,
    options: { methods?: string[]; limit?: number } = {},
  ): Promise<
    { ok: true; events: Array<{ method: string; params?: Record<string, unknown> }> } | { ok: false; error: string }
  > {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    try {
      const events = await entry.host.readCdpEvents(options);
      return { ok: true, events };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 读剪贴板文本。 */
  async clipboardRead(
    identity: BrowserSessionIdentity,
    tabId: number,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      const text = await entry.host.clipboardReadText();
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 写剪贴板文本。 */
  async clipboardWrite(
    identity: BrowserSessionIdentity,
    tabId: number,
    text: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.clipboardWriteText(text);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 按选择器执行元素操作（对齐 Codex PlaywrightLocator）。 */
  async locatorAction(
    identity: BrowserSessionIdentity,
    tabId: number,
    selector: string,
    action: Parameters<BrowserHostController["locatorAction"]>[1],
    params: {
      value?: string;
      attribute?: string;
      by?: "css" | "role" | "text" | "label" | "placeholder" | "testid";
      byValue?: string;
      frame?: string;
      nth?: number;
    } = {},
  ): Promise<
    | {
        ok: true;
        value?: string;
        count?: number;
        visible?: boolean;
        enabled?: boolean;
        info?: Record<string, unknown>;
        screenshot?: { dataUrl: string; width: number; height: number };
      }
    | { ok: false; error: string }
  > {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      return await entry.host.locatorAction(selector, action, params);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 原始 CDP 命令（对齐 Codex cdp.send）。 */
  async cdpSend(
    identity: BrowserSessionIdentity,
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      const result = await entry.host.cdpSend(method, params);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 等待下一次导航完成（对齐 Codex expectNavigation）。 */
  async expectNavigation(
    identity: BrowserSessionIdentity,
    tabId: number,
    timeoutMs?: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.expectNavigation(timeoutMs);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 拖拽：沿坐标路径移动鼠标（对齐 Codex CUA drag）。 */
  async dragPath(
    identity: BrowserSessionIdentity,
    tabId: number,
    points: Array<{ x: number; y: number }>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.dragPath(points);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 移动鼠标到坐标（对齐 Codex CUA move）。 */
  async moveMouse(
    identity: BrowserSessionIdentity,
    tabId: number,
    x: number,
    y: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.moveMouse(x, y);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 坐标双击（对齐 Codex CUA double_click）。 */
  async dblclickPoint(
    identity: BrowserSessionIdentity,
    tabId: number,
    x: number,
    y: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.dblclickPoint(x, y);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 导出页面主文本（对齐 Codex ContentAPI.export）。 */
  async contentExport(
    identity: BrowserSessionIdentity,
    tabId: number,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      const text = await entry.host.contentExport();
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 最近下载记录（对齐 Codex downloadMedia 的追踪能力）。 */
  async downloadEvents(
    identity: BrowserSessionIdentity,
    tabId: number,
  ): Promise<
    | { ok: true; downloads: Array<{ url: string; filename: string; path: string | null }> }
    | { ok: false; error: string }
  > {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    try {
      const downloads = await entry.host.downloadEvents();
      return { ok: true, downloads };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 文件上传（对齐 Codex PlaywrightFileChooser.setFiles）。 */
  async uploadFile(
    identity: BrowserSessionIdentity,
    tabId: number,
    selector: string,
    filePath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.uploadFile(selector, filePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 触发下载并保存（对齐 Codex downloadMedia）。 */
  async downloadMedia(
    identity: BrowserSessionIdentity,
    tabId: number,
    url: string,
    savePath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.downloadMedia(url, savePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 坐标点击（对齐 Codex CUA clickPoint）。 */
  async clickPoint(
    identity: BrowserSessionIdentity,
    tabId: number,
    x: number,
    y: number,
    keys?: string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const state = this.requireSession(identity);
    if (!state) return { ok: false, error: "未知的浏览器会话" };
    const entry = state.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    const policyError = this.blockedAgentTabError(entry);
    if (policyError !== null) return { ok: false, error: policyError };
    this.activateAgentTab(state, tabId);
    try {
      await entry.host.clickPoint(x, y, keys);
      return { ok: true };
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
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([Uint8Array.from(image.toPNG())], { type: "image/png" }),
        }),
      ]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 显示 guest 页面原生 Chromium 右键菜单。 */
  private async handleContextMenu(
    state: SessionState,
    tabId: number,
    webContents: WebContents,
    event: Electron.Event,
    params: Electron.ContextMenuParams,
  ): Promise<void> {
    const entry = state.entries.get(tabId);
    if (!entry || this.disposed) return;

    event.preventDefault();
    let contacts: ContactProfile[] = [];
    if (this.options.data) {
      try {
        contacts = (await this.options.data.getSnapshot()).contacts;
      } catch (error) {
        this.options.log?.(`browser context menu contacts failed: ${messageOf(error)}`);
      }
    }
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
      copyText: (text) => {
        void clipboard.writeText(text).catch((error: unknown) => {
          this.options.log?.(`browser context menu copy failed: ${messageOf(error)}`);
        });
      },
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
      autofillContacts: contacts.slice(0, 8).map((contact) => ({
        id: contact.id,
        label: [contact.fullName, contact.email, contact.phone].filter(Boolean).join(" · "),
      })),
      autofillContact: (id) => {
        const contact = contacts.find((candidate) => candidate.id === id);
        if (!contact) return;
        void webContents.executeJavaScript(buildBrowserContactAutofillScript(contact), true).catch((error: unknown) => {
          this.options.log?.(`browser contact autofill failed: ${messageOf(error)}`);
        });
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

  /** 浏览器用户数据快照（历史/下载/联系人/密码/网站设置；仅用户 UI）。 */
  async browserDataGet(includePasswords = false): Promise<BrowserDataSnapshot> {
    if (!this.options.data) {
      return { history: [], downloads: [], contacts: [], passwords: [], sitePermissions: [] };
    }
    try {
      const snapshot = await this.options.data.getSnapshot();
      return includePasswords ? snapshot : { ...snapshot, passwords: [] };
    } catch (error) {
      this.options.log?.(`browser data get failed: ${messageOf(error)}`);
      return { history: [], downloads: [], contacts: [], passwords: [], sitePermissions: [] };
    }
  }

  /** 删除单条历史记录（按 url + timestamp 精确匹配）。 */
  async browserHistoryDelete(url: string, timestamp: number): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return redactPasswords(await this.options.data.deleteHistoryEntry(url, timestamp));
  }

  /** 清空全部浏览历史。 */
  async browserHistoryClear(): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return redactPasswords(await this.options.data.clearHistory());
  }

  /** 清空全部下载历史（不删除已下载文件）。 */
  async browserDownloadsClear(): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return redactPasswords(await this.options.data.clearDownloads());
  }

  /** 在系统文件管理器中显示已下载文件。 */
  browserDownloadReveal(path: string): void {
    if (path.length === 0) return;
    shell.showItemInFolder(path);
  }

  /** 用系统默认程序打开已下载文件。 */
  async browserDownloadOpen(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (path.length === 0) return { ok: false, error: "文件路径为空" };
    const error = await shell.openPath(path);
    return error ? { ok: false, error } : { ok: true };
  }

  /** 新增/更新联系信息（contactId 为 null 时新建）。 */
  async browserContactSave(input: {
    contactId: string | null;
    contact: BrowserContactInput;
  }): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return redactPasswords(await this.options.data.saveContact(input));
  }

  /** 删除联系信息。 */
  async browserContactDelete(id: string): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return redactPasswords(await this.options.data.deleteContact(id));
  }

  /** 新增/更新保存的密码（passwordId 为 null 时新建）。 */
  async browserPasswordSave(input: {
    passwordId: string | null;
    password: BrowserPasswordInput;
  }): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return this.options.data.savePassword(input);
  }

  /** 删除保存的密码。 */
  async browserPasswordDelete(id: string): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    return this.options.data.deletePassword(id);
  }

  /** 新增/更新网站设置条目（同 site+kind 覆盖）。 */
  async browserSitePermissionSave(input: BrowserSitePermissionInput): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    const result = await this.options.data.saveSitePermission(input);
    if (result.ok) await this.loadSitePermissionOverrides();
    return redactPasswords(result);
  }

  /** 删除网站设置条目。 */
  async browserSitePermissionDelete(id: string): Promise<BrowserDataMutateResult> {
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    const result = await this.options.data.deleteSitePermission(id);
    if (result.ok) await this.loadSitePermissionOverrides();
    return redactPasswords(result);
  }

  /** 用户对密码保存请求的响应（保存 / 忽略）。 */
  async browserPasswordOfferResolve(
    identity: BrowserSessionIdentity,
    offerId: string,
    save: boolean,
    ownerWebContentsId: number,
  ): Promise<BrowserPasswordOfferResolveResult> {
    const offer = this.passwordOffers.get(offerId);
    if (
      !offer ||
      offer.ownerWebContentsId !== ownerWebContentsId ||
      browserSessionKey(offer.identity) !== browserSessionKey(identity)
    ) {
      return { ok: false, error: "密码保存请求不存在或已过期。" };
    }
    const timer = this.passwordOfferTimers.get(offerId);
    if (timer) clearTimeout(timer);
    this.passwordOffers.delete(offerId);
    this.passwordOfferTimers.delete(offerId);
    if (!save) return { ok: true };
    if (!this.options.data) return { ok: false, error: "浏览器数据服务不可用" };
    try {
      const existing = (await this.options.data.getSnapshot()).passwords.find(
        (entry) => entry.origin === offer.origin && entry.username === offer.username,
      );
      const result = await this.options.data.savePassword({
        passwordId: existing ? existing.id : null,
        password: { origin: offer.origin, username: offer.username, password: offer.password },
      });
      return result.ok ? { ok: true } : result;
    } catch (error) {
      this.options.log?.(`browser password offer save failed: ${messageOf(error)}`);
      return { ok: false, error: "密码保存失败。" };
    }
  }

  /** 页面加载后注入表单脚本：登录检测 + 已保存凭据自动填充。 */
  private async injectFormScripts(webContents: WebContents, host: BrowserHostController): Promise<void> {
    if (webContents.isDestroyed()) return;
    try {
      await host.addRuntimeBinding(BROWSER_PASSWORD_OFFER_BINDING);
      await webContents.executeJavaScript(BROWSER_PASSWORD_WATCHER_SCRIPT, true);
    } catch {
      return;
    }
    const dataService = this.options.data;
    if (!dataService || webContents.isDestroyed()) return;
    const origin = originOfUrl(webContents.getURL());
    if (origin === null) return;
    let passwords: SavedPassword[];
    try {
      passwords = (await dataService.getSnapshot()).passwords;
    } catch {
      return;
    }
    if (webContents.isDestroyed() || originOfUrl(webContents.getURL()) !== origin) return;
    try {
      await webContents.executeJavaScript(buildBrowserPasswordAutofillScript({ origin, passwords }), true);
    } catch {
      // 页面上下文可能已销毁
    }
  }

  /** guest Runtime binding 上报登录表单提交：校验后发送无密码保存请求。 */
  private handlePasswordOfferMessage(state: SessionState, tabId: number, payload: string): void {
    if (!this.options.data || !this.options.onPasswordOffer) return;
    let parsed: { url?: unknown; username?: unknown; password?: unknown };
    try {
      parsed = JSON.parse(payload) as { url?: unknown; username?: unknown; password?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.password !== "string" || parsed.password.length === 0) return;
    if (typeof parsed.username !== "string") return;
    const rawUrl = typeof parsed.url === "string" ? parsed.url : "";
    const origin = originOfUrl(rawUrl);
    if (origin === null) return;
    const entry = state.entries.get(tabId);
    if (!entry || originOfUrl(entry.tab.url) !== origin) return;
    const currentUrl = entry.tab.url;
    const id = randomUUID();
    this.passwordOffers.set(id, {
      ownerWebContentsId: entry.ownerWebContentsId,
      identity: { ...state.identity },
      origin,
      username: parsed.username,
      password: parsed.password,
    });
    const timer = setTimeout(
      () => {
        this.passwordOffers.delete(id);
        this.passwordOfferTimers.delete(id);
      },
      2 * 60 * 1000,
    );
    this.passwordOfferTimers.set(id, timer);
    this.options.onPasswordOffer(
      {
        id,
        url: currentUrl,
        origin,
        username: parsed.username,
        identity: { ...state.identity },
      },
      entry.ownerWebContentsId,
    );
  }

  /** 网站设置覆盖查询（同步；权限 handler 使用）。 */
  private siteOverride(origin: string, kind: BrowserPermissionKind | null): BrowserPermissionValue | null {
    if (kind === null || origin.length === 0) return null;
    const bySite = this.sitePermissionOverrides.get(kind);
    if (!bySite) return null;
    const matches = [...bySite].filter(([site]) => siteMatches(site, origin));
    matches.sort(([left], [right]) => right.length - left.length);
    return matches[0]?.[1] ?? null;
  }

  private async loadSitePermissionOverrides(): Promise<void> {
    const generation = ++this.sitePermissionLoadGeneration;
    if (!this.options.data) {
      this.sitePermissionOverridesLoaded = true;
      return;
    }
    try {
      const permissions = await this.options.data.listSitePermissions();
      if (generation !== this.sitePermissionLoadGeneration) return;
      this.rebuildSitePermissionOverrides(permissions);
      this.sitePermissionOverridesLoaded = true;
    } catch (error) {
      if (generation !== this.sitePermissionLoadGeneration) return;
      this.sitePermissionOverridesLoaded = false;
      this.options.log?.(`browser site permission load failed: ${messageOf(error)}`);
    }
  }

  private rebuildSitePermissionOverrides(permissions: BrowserSitePermission[]): void {
    const overrides = new Map<BrowserPermissionKind, Map<string, BrowserPermissionValue>>();
    for (const entry of permissions) {
      let bySite = overrides.get(entry.kind);
      if (!bySite) {
        bySite = new Map();
        overrides.set(entry.kind, bySite);
      }
      bySite.set(entry.site, entry.value);
    }
    this.sitePermissionOverrides = overrides;
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

  /** 按 id 批量删除标注（composer 成功发送后消费）；id 在会话内全局唯一，跨 tab 匹配。 */
  async removeAnnotations(identity: BrowserSessionIdentity, ids: string[]): Promise<void> {
    const state = this.requireSession(identity);
    if (!state || ids.length === 0) return;
    const wanted = new Set(ids);
    for (const [tabId, list] of state.annotationsByTab) {
      const next = list.filter((annotation) => !wanted.has(annotation.id));
      if (next.length === 0) state.annotationsByTab.delete(tabId);
      else if (next.length !== list.length) state.annotationsByTab.set(tabId, next);
    }
  }

  /** 原位更新标注文本（保持 id/createdAt/selector/bounds/tag 不变）；不存在返回 null。 */
  async updateAnnotation(
    identity: BrowserSessionIdentity,
    tabId: number,
    id: string,
    input: BrowserAnnotationUpdateInput,
  ): Promise<BrowserAnnotation | null> {
    const state = this.requireSession(identity);
    if (!state) return null;
    const list = state.annotationsByTab.get(tabId);
    if (!list) return null;
    const index = list.findIndex((annotation) => annotation.id === id);
    if (index === -1) return null;
    const updated: BrowserAnnotation = { ...list[index]!, text: input.text };
    list[index] = updated;
    return { ...updated };
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
    for (const timer of this.passwordOfferTimers.values()) clearTimeout(timer);
    this.passwordOfferTimers.clear();
    this.passwordOffers.clear();
    for (const state of this.sessions.values()) {
      state.browserSession.off("will-download", state.onWillDownload);
      for (const pending of state.pendingCreates.values()) {
        if (pending.onAbort) pending.abort?.removeEventListener("abort", pending.onAbort);
        pending.reject(new Error("浏览器服务已关闭"));
      }
      state.pendingCreates.clear();
      for (const entry of state.entries.values()) {
        entry.disposeGuestListeners();
        entry.host.dispose();
      }
      state.entries.clear();
      state.byWebContentsId.clear();
      state.activeTabId = null;
    }
    this.sessions.clear();
    this.sessionCapabilities.clear();
    this.sessionOwners.clear();
  }

  /** 会话状态（不存在则创建）。IPC（renderer）路径使用：renderer 是受信应用代码。 */
  private ensureSession(identity: BrowserSessionIdentity): SessionState {
    const sessionKey = browserSessionKey(identity);
    this.knownSessions.add(sessionKey);
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    const partition = browserPartitionFor(identity);
    const browserSession = session.fromPartition(partition);
    this.options.onSessionCreated?.(browserSession);
    // 分区权限默认 fail-closed：媒体权限按浏览器设置中的默认值和站点覆盖处理，
    // 网站设置覆盖（camera/microphone/notifications/geolocation/clipboard/fullscreen）
    // 优先于默认值，其他 Chromium 权限（地理位置、通知、剪贴板等）统一拒绝。
    browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      if (!this.sitePermissionOverridesLoaded) return false;
      if (permission === "media") {
        const mediaType = (details as Electron.PermissionCheckHandlerHandlerDetails).mediaType;
        if (mediaType === "video" || mediaType === "audio") {
          const override = this.siteOverride(requestingOrigin, mediaType === "video" ? "camera" : "microphone");
          if (override !== null) return override === "allow";
        }
        return mediaType !== undefined && mediaType !== "unknown"
          ? mediaPermissionAllowed(this.runtimeSettings, requestingOrigin, mediaType)
          : false;
      }
      const override = this.siteOverride(requestingOrigin, permissionToPermissionKind(permission));
      return override !== null && override === "allow";
    });
    browserSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (!this.sitePermissionOverridesLoaded) {
        callback(false);
        return;
      }
      const request = details as Electron.MediaAccessPermissionRequest;
      const origin = request.securityOrigin ?? request.requestingUrl ?? "";
      if (permission === "media") {
        const mediaTypes = request.mediaTypes ?? [];
        const kinds = mediaTypes.map((mediaType) =>
          mediaType === "video" ? ("camera" as const) : mediaType === "audio" ? ("microphone" as const) : null,
        );
        const allowed = kinds.every((kind, index) => {
          if (kind === null) return false;
          const override = this.siteOverride(origin, kind);
          return override !== null
            ? override === "allow"
            : mediaPermissionAllowed(this.runtimeSettings, origin, mediaTypes[index]!);
        });
        callback(mediaTypes.length > 0 && allowed);
        return;
      }
      const override = this.siteOverride(origin, permissionToPermissionKind(permission));
      if (override !== null) {
        callback(override === "allow");
        return;
      }
      callback(false);
    });
    const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
      const directory = this.runtimeSettings.downloadDirectory;
      const filename = basename(item.getFilename());
      if (filename.length === 0) return;
      if (directory) item.setSavePath(join(directory, filename));
      if (!this.options.data) return;
      const url = item.getURL();
      const startedAt = Date.now();
      item.once("done", (_event, state) => {
        const savePath = item.getSavePath();
        void this.options.data
          ?.recordDownload({
            url,
            filename,
            path: state === "completed" ? savePath : null,
            totalBytes: item.getTotalBytes(),
            receivedBytes: item.getReceivedBytes(),
            state: state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted",
            startedAt,
            endedAt: Date.now(),
          })
          .catch(() => undefined);
      });
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
      case "navigated": {
        // URL 真正切换后旧页面的标注不再有效：清空该 tab 的标注（同 URL 重复事件不清）。
        const previousUrl = entry.tab.url;
        entry.tab.url = event.url;
        entry.tab.canGoBack = event.canGoBack;
        entry.tab.canGoForward = event.canGoForward;
        entry.tab.crashed = false;
        entry.tab.loadError = undefined;
        if (!sameBrowserUrl(previousUrl, event.url)) state.annotationsByTab.delete(tabId);
        this.recordHistory(state, tabId, event.url, entry.tab.title);
        break;
      }
      case "navigated-in-page": {
        const previousUrl = entry.tab.url;
        entry.tab.url = event.url;
        entry.tab.loadError = undefined;
        if (!sameBrowserUrl(previousUrl, event.url)) state.annotationsByTab.delete(tabId);
        try {
          const navigation = entry.host.getNavigationState();
          entry.tab.canGoBack = navigation.activeIndex > 0;
          entry.tab.canGoForward = navigation.activeIndex < navigation.entries.length - 1;
        } catch {
          // history API 查询失败时保留上一份按钮状态。
        }
        break;
      }
      case "title-updated":
        entry.tab.title = event.title;
        // 同步历史中该 tab 最后一条同 URL 记录的标题（导航后标题异步到达）。
        if (state.lastHistoryUrlByTab.get(tabId) === entry.tab.url) {
          const historyIndex = state.history.findIndex((item) => item.url === entry.tab.url);
          if (historyIndex !== -1) {
            state.history[historyIndex] = { ...state.history[historyIndex]!, title: event.title };
            if (this.options.data) {
              void this.options.data.updateLatestHistoryTitle(entry.tab.url, event.title).catch(() => undefined);
            }
          }
        }
        break;
      case "loading-changed":
        entry.tab.loading = event.loading;
        if (event.loading) entry.tab.loadError = undefined;
        break;
      case "load-failed": {
        entry.tab.loading = false;
        // 失败导航同样代表离开旧页面：URL 真正变化时清理该 tab 标注。首次失败后
        // 重试成功时 navigated 的 previousUrl 与 event.url 相同，不会再次触发
        // 清理，因此必须在 load-failed 阶段完成；同 URL 重复失败不误删当前页标注。
        const previousUrl = entry.tab.url;
        const nextUrl = event.url || entry.tab.url;
        entry.tab.url = nextUrl;
        try {
          entry.tab.title = new URL(nextUrl).hostname || nextUrl;
        } catch {
          entry.tab.title = nextUrl;
        }
        entry.tab.loadError = {
          code: event.code,
          description: event.description,
          url: event.url,
        };
        if (!sameBrowserUrl(previousUrl, nextUrl)) state.annotationsByTab.delete(tabId);
        break;
      }
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
    const tabIds = [...state.entries.keys()];
    const closedIndex = tabIds.indexOf(tabId);
    state.entries.delete(tabId);
    state.byWebContentsId.delete(entry.webContentsId);
    state.lastHistoryUrlByTab.delete(tabId);
    state.annotationsByTab.delete(tabId);
    if (state.activeTabId === tabId) {
      // Chrome 行为：关闭活跃标签后选中相邻标签，优先右侧；关闭最后一个时选中左侧。
      const neighborIndex = closedIndex < tabIds.length - 1 ? closedIndex + 1 : closedIndex - 1;
      state.activeTabId = neighborIndex >= 0 ? (tabIds[neighborIndex] ?? null) : null;
    }
    entry.disposeGuestListeners();
    entry.host.dispose();
    this.broadcast(state);
  }

  /** 记录访问历史：忽略空白页和 browser:// WebUI；同一 tab 重复导航同 URL 不重复。 */
  private recordHistory(state: SessionState, tabId: number, url: string, title: string): void {
    if (url === "about:blank" || parseBrowserInternalPage(url) !== null) return;
    if (state.lastHistoryUrlByTab.get(tabId) === url) return;
    state.lastHistoryUrlByTab.set(tabId, url);
    const existing = state.history.findIndex((entry) => entry.url === url);
    if (existing !== -1) {
      const current = state.history.splice(existing, 1)[0]!;
      state.history.unshift({ url, title: title || current.title, timestamp: Date.now() });
    } else {
      state.history.unshift({ url, title, timestamp: Date.now() });
      if (state.history.length > MAX_HISTORY_ENTRIES) state.history.length = MAX_HISTORY_ENTRIES;
    }
    if (this.options.data) {
      void this.options.data.recordHistory(url, title).catch(() => undefined);
    }
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

  private agentSettingsError(): string | null {
    if (this.runtimeSettingsLoadFailed) return "无法读取浏览器设置，请确认浏览器服务正常后重试";
    return this.runtimeSettings.enabled ? null : "内置浏览器已在设置中关闭";
  }

  private blockedAgentTabError(entry: TabEntry): string | null {
    if (entry.internalPage || parseBrowserInternalPage(entry.tab.url) !== null) {
      return "browser:// 内部页面仅供用户操作";
    }
    return this.blockedAgentSiteError(entry.tab.url);
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
    if (defaultSiteApproval(this.runtimeSettings) === "always-allow") return true;
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

function parseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function mediaPermissionAllowed(settings: BrowserSettings, origin: string, mediaType: "video" | "audio"): boolean {
  if (!origin || checkSiteAccess(settings, origin) === "blocked") return false;
  const sitePermission = settings.mediaPermissions
    .filter((entry) => siteMatches(entry.site, origin))
    .sort((left, right) => right.site.length - left.site.length)[0];
  const decision =
    mediaType === "video"
      ? (sitePermission?.camera ?? settings.mediaDefault)
      : (sitePermission?.microphone ?? settings.mediaDefault);
  return decision === "allow";
}

/** Chromium 权限名 -> 网站设置权限类型；未纳入网站设置的权限返回 null。 */
function permissionToPermissionKind(permission: string): BrowserPermissionKind | null {
  switch (permission) {
    case "notifications":
      return "notifications";
    case "geolocation":
      return "geolocation";
    case "clipboard-sanitized-write":
    case "clipboard-read":
      return "clipboard";
    case "fullscreen":
      return "fullscreen";
    default:
      return null;
  }
}

/** http/https URL 的 origin（含端口）；其他协议返回 null。 */
function originOfUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function redactPasswords(result: BrowserDataMutateResult): BrowserDataMutateResult {
  return result.ok ? { ok: true, snapshot: { ...result.snapshot, passwords: [] } } : result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
