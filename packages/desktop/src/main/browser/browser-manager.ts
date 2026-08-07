/**
 * 内置浏览器（IAB）主进程服务：管理浏览器 tab 生命周期、导航、截图与状态广播。
 *
 * - tab 注册：renderer 创建 `<webview>` 后上报 guest webContentsId，main 注册为
 *   tab 并订阅宿主事件（导航/标题/加载/崩溃/销毁）。
 * - 状态广播：任何 tab 状态变化后立即调用 `onStateChanged`（P0 不做节流，
 *   P1 若事件过于频繁再合并）。
 * - 导航只允许 http/https（file:// 等拒绝）；URL 补全是 renderer 职责。
 * - 设置读写委托 BrowserSettingsService。
 *
 * 宿主无关：CDP（元素级交互）在 P1 通过 BrowserHostController 新实现扩展，
 * 不改变本类公开接口。
 */

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { WebContents } from "electron";
import { webContents as electronWebContents, session } from "electron";
import {
  BROWSER_PARTITION,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserAnnotation,
  type BrowserAnnotationBounds,
  type BrowserAnnotationInput,
  type BrowserAnnotationPickResult,
  type BrowserAttachResult,
  type BrowserCreateTabRequest,
  type BrowserInspectElementResult,
  type BrowserNavigateResult,
  type BrowserNavigationTargetResult,
  type BrowserOpenTabResult,
  type BrowserScreenshotResult,
  type BrowserSnapshotResult,
  type BrowserStateEvent,
  type BrowserTab,
} from "../../shared/browser-contracts.ts";
import type {
  BrowserSettings,
  BrowserSettingsSnapshot,
  SaveBrowserSettingsInput,
  SaveBrowserSettingsResult,
} from "../../shared/browser-settings-contracts.ts";
import { defaultBrowserSettings } from "../../shared/browser-settings-contracts.ts";
import { checkSiteAccess } from "../../shared/browser-site-policy.ts";
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
  /** tab 状态变化时广播；由 index.ts 注入跨窗口推送实现。 */
  onStateChanged?: (event: BrowserStateEvent) => void;
  /** 工具侧建 tab 请求广播；由 index.ts 注入。 */
  onCreateTabRequest?: (request: BrowserCreateTabRequest) => void;
  /** 服务日志（可选）。 */
  log?: (text: string) => void;
  /** 测试注入：替换宿主创建逻辑。 */
  createHost?: (webContentsId: number, options?: WebContentsHostControllerOptions) => BrowserHostController;
  /** 测试注入：替换 webContents.fromId 解析。 */
  fromWebContentsId?: (webContentsId: number) => WebContents | null;
  /** 测试注入：覆盖设置文件路径。 */
  settingsPath?: string;
  /** 测试注入：openTab 等待 renderer attach 的超时（默认 15s）。 */
  openTabTimeoutMs?: number;
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
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_OPEN_TAB_TIMEOUT_MS = 15_000;
const CREATE_REQUEST_TOMBSTONE_TTL_MS = 60_000;

/** 内置浏览器主进程服务。 */
export class BrowserManager {
  private readonly options: BrowserManagerOptions;
  private readonly settingsService: BrowserSettingsService;
  private readonly browserSession: Electron.Session;
  private readonly onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
    const directory = this.runtimeSettings.downloadDirectory;
    if (!directory) return;
    const filename = basename(item.getFilename());
    if (filename.length === 0) return;
    item.setSavePath(join(directory, filename));
  };
  private runtimeSettings: BrowserSettings = defaultBrowserSettings();
  private runtimeSettingsLoaded = false;
  private runtimeSettingsLoadFailed = false;
  private readonly settingsReady: Promise<void>;
  private readonly entries = new Map<number, TabEntry>(); // tabId -> entry
  private readonly byWebContentsId = new Map<number, number>(); // webContentsId -> tabId
  private activeTabId: number | null = null;
  private nextTabId = 1;
  private nextCreateRequestId = 1;
  private readonly pendingCreates = new Map<number, PendingCreateTab>();
  private readonly expiredCreateRequests = new Map<number, ReturnType<typeof setTimeout>>();
  private disposed = false;
  /** 访问历史（最近在前，上限 MAX_HISTORY_ENTRIES；仅内存态，供地址栏搜索与 UI）。 */
  private readonly history: BrowserHistoryEntry[] = [];
  /** tabId -> 最近记录过的 URL（连续重复导航不重复记录）。 */
  private readonly lastHistoryUrlByTab = new Map<number, string>();
  /** tabId -> 标注列表（标注模式，§11；仅内存态）。 */
  private readonly annotationsByTab = new Map<number, BrowserAnnotation[]>();

  constructor(userDataDir: string, options: BrowserManagerOptions = {}) {
    this.options = options;
    this.settingsService = new BrowserSettingsService(userDataDir, {
      path: options.settingsPath,
    });
    this.browserSession = session.fromPartition(BROWSER_PARTITION);
    this.settingsReady = this.refreshRuntimeSettings();
    // 分区权限默认全部拒绝（spec §10）：未设置 handler 时 Electron 默认放行
    // 权限请求，恶意页面可静默取得摄像头/麦克风/地理位置等；P1 再按
    // media 类弹窗询问等策略细化。
    this.browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.browserSession.on("will-download", this.onWillDownload);
  }

  /** renderer 在 webview attach 后上报 guest webContentsId；重复上报幂等返回已有 tab。
   *  requestId 用于匹配 BrowserManager.openTab 发出的建 tab 请求。 */
  async attach(webContentsId: number, requestId?: number): Promise<BrowserAttachResult> {
    if (this.disposed) return { ok: false, error: "浏览器服务已关闭" };

    const existingTabId = this.byWebContentsId.get(webContentsId);
    if (existingTabId !== undefined) {
      const entry = this.entries.get(existingTabId);
      if (entry) return { ok: true, tab: { ...entry.tab } };
    }

    const resolved =
      this.options.fromWebContentsId?.(webContentsId) ?? electronWebContents.fromId(webContentsId) ?? null;
    if (!resolved) return { ok: false, error: `webContents ${webContentsId} 不存在` };
    if (resolved.session !== this.browserSession) {
      return { ok: false, error: `webContents ${webContentsId} 不属于浏览器分区` };
    }
    if (!resolved.hostWebContents) {
      return { ok: false, error: `webContents ${webContentsId} 不是浏览器 guest` };
    }
    const initialUrl = resolved.getURL();
    if (!isBrowserWebviewUrl(initialUrl)) {
      return { ok: false, error: `webContents ${webContentsId} 的 URL 不符合浏览器页面要求` };
    }

    if (requestId !== undefined && !this.pendingCreates.has(requestId)) {
      if (this.expiredCreateRequests.has(requestId)) {
        return { ok: false, error: `建 tab 请求 ${requestId} 已超时，请重新打开` };
      }
      return { ok: false, error: `未知的建 tab 请求 ${requestId}` };
    }

    await this.settingsReady;
    const tabId = this.nextTabId++;
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
        this.allowAgentNavigation(tabId, url, currentUrl, approvedUrl),
      onPopup: (url) => {
        void this.openTab(url, "popup").catch((error: unknown) => {
          this.options.log?.(`browser popup rejected: ${messageOf(error)}`);
        });
      },
    };
    const host =
      this.options.createHost?.(webContentsId, hostOptions) ?? new WebContentsHostController(resolved, hostOptions);
    this.entries.set(tabId, { tabId, webContentsId, host, tab });
    this.byWebContentsId.set(webContentsId, tabId);
    host.onEvent((event) => this.handleHostEvent(tabId, event));
    this.activeTabId = tabId;
    this.broadcast();

    // 若该 webContents 是对 openTab 建 tab 请求的响应：完成请求并导航目标 URL。
    if (requestId !== undefined) {
      const pending = this.pendingCreates.get(requestId);
      if (pending) {
        this.pendingCreates.delete(requestId);
        clearTimeout(pending.timer);
        const navigation = await this.navigate(tabId, pending.url, pending.source);
        if (!navigation.ok) {
          this.removeEntry(tabId);
          pending.resolve({ ok: false, error: navigation.error });
          return { ok: false, error: navigation.error };
        }
        // 导航后回读 entry.tab（navigate 的 did-navigate 事件可能已更新 URL/标题）。
        const current = this.entries.get(tabId);
        pending.resolve({ ok: true, tab: current ? { ...current.tab } : { ...tab } });
      }
    }
    return { ok: true, tab: { ...tab } };
  }

  /** renderer 移除 webview 时注销；幂等。 */
  async detach(webContentsId: number): Promise<void> {
    const tabId = this.byWebContentsId.get(webContentsId);
    if (tabId !== undefined) this.removeEntry(tabId);
  }

  /** 切换活跃 tab；不存在时返回 null。 */
  selectTab(tabId: number): BrowserTab | null {
    const entry = this.entries.get(tabId);
    if (!entry) return null;
    this.activeTabId = tabId;
    this.broadcast();
    return { ...entry.tab };
  }

  tabsList(): BrowserTab[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.tab }));
  }

  /** 当前活跃 tab；无 tab 或服务已关闭时返回 null。 */
  activeTab(): BrowserTab | null {
    if (this.activeTabId === null) return null;
    const entry = this.entries.get(this.activeTabId);
    return entry ? { ...entry.tab } : null;
  }

  /** 由工具侧发起建 tab：广播建 tab 请求并等待 renderer 创建 webview 后 attach。 */
  async openTab(url: string, source: BrowserOperationSource = "agent"): Promise<BrowserOpenTabResult> {
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
    const request: BrowserCreateTabRequest = { requestId, url: normalized };
    const result = await new Promise<BrowserOpenTabResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreates.delete(requestId);
        const expiry = setTimeout(() => this.expiredCreateRequests.delete(requestId), CREATE_REQUEST_TOMBSTONE_TTL_MS);
        this.expiredCreateRequests.set(requestId, expiry);
        resolve({ ok: false, error: `创建浏览器标签页超时（${openTabTimeoutOf(this.options)}ms）` });
      }, openTabTimeoutOf(this.options));
      this.pendingCreates.set(requestId, { url: normalized, source, resolve, reject, timer });
      this.options.onCreateTabRequest?.(request);
    });
    return result;
  }

  /** 结构化页面快照（AX 树简化 + 可交互元素编号 + 可选截图）。 */
  async snapshot(
    tabId: number,
    opts: { withScreenshot?: boolean } = {},
    source: BrowserOperationSource = "user",
  ): Promise<BrowserSnapshotResult> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent") this.activateAgentTab(tabId);
    if (source === "agent") {
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const snapshot = await entry.host.snapshot({ withScreenshot: opts.withScreenshot === true });
      return { ok: true, snapshot };
    } catch (error) {
      this.options.log?.(`browser snapshot failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 元素级交互（click/type/scroll），编号来自最近一次 snapshot。 */
  async action(
    tabId: number,
    action: BrowserAction,
    source: BrowserOperationSource = "user",
  ): Promise<BrowserActionResult> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent" && (action.type === "click" || action.type === "type") && action.target === undefined) {
      return { ok: false, error: "元素引用缺少快照指纹，请重新 browser_snapshot 后再操作", staleRef: true };
    }
    if (source === "agent") this.activateAgentTab(tabId);
    if (source === "agent") {
      const expectedUrl = action.type === "scroll" ? action.expectedUrl : action.target?.pageUrl;
      if (expectedUrl !== undefined && !sameBrowserUrl(expectedUrl, entry.tab.url)) {
        return { ok: false, error: "页面已变化，元素引用已失效，请重新获取页面快照", staleRef: true };
      }
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const outcome = await entry.host.performAction(action, { agent: source === "agent" });
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
  inspectElement(tabId: number, elementIndex: number): BrowserInspectElementResult {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    this.activateAgentTab(tabId);
    const policyError = this.blockedAgentSiteError(entry.tab.url);
    if (policyError !== null) return { ok: false, error: policyError };
    const node = entry.host.inspectElement(elementIndex);
    return node ? { ok: true, node } : { ok: false, error: "元素编号已失效，请重新获取页面快照", staleRef: true };
  }

  /** 导航到 URL；仅 http/https，其余协议拒绝；URL 补全是 renderer 职责。
   *  loadURL 挂起（连接无响应）时按 NAVIGATE_TIMEOUT_MS 超时返回错误。 */
  async navigate(tabId: number, url: string, source: BrowserOperationSource = "user"): Promise<BrowserNavigateResult> {
    const normalized = normalizeNavigateUrl(url);
    if (!normalized) return { ok: false, error: "仅支持 http/https 链接" };
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "popup" && checkSiteAccess(this.runtimeSettings, normalized) !== "allowed") {
      return { ok: false, error: `站点 ${new URL(normalized).host} 未列入允许列表，页面弹窗已阻止` };
    }
    if (source === "agent") this.activateAgentTab(tabId);
    if (source === "agent") {
      const currentPolicyError = this.blockedAgentSiteError(entry.tab.url);
      if (currentPolicyError !== null) return { ok: false, error: currentPolicyError };
      const targetAccess = checkSiteAccess(this.runtimeSettings, normalized);
      if (targetAccess === "blocked") {
        return { ok: false, error: `站点 ${new URL(normalized).host} 已列入禁止访问列表，无法操作` };
      }
    }
    try {
      await withTimeout(
        entry.host.navigate(normalized, { agent: source === "agent", navigationApprovalUrl: normalized }),
        NAVIGATE_TIMEOUT_MS,
        () => entry.host.cancelPendingOperations(),
        `导航超时（${NAVIGATE_TIMEOUT_MS}ms）`,
      );
    } catch (error) {
      this.options.log?.(`browser navigate failed: ${messageOf(error)}`);
      return { ok: false, error: messageOf(error) };
    }
    // did-navigate 事件最终更新 tab.url；此处返回当前状态即可。
    return { ok: true, tab: { ...entry.tab } };
  }

  /** 返回历史动作的目标 URL，Agent 在真正调用 back/forward 前据此完成站点审批。 */
  navigationTarget(tabId: number, direction: "back" | "forward"): BrowserNavigationTargetResult {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    this.activateAgentTab(tabId);
    try {
      const state = entry.host.getNavigationState();
      const targetIndex = state.activeIndex + (direction === "back" ? -1 : 1);
      const target = state.entries[targetIndex];
      const current = state.entries[state.activeIndex] ?? { url: entry.tab.url, title: entry.tab.title };
      if (!target) return { ok: false, error: `没有可${direction === "back" ? "后退" : "前进"}的历史记录` };
      return { ok: true, current, target };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 后退；无历史时返回错误。 */
  async goBack(
    tabId: number,
    source: BrowserOperationSource = "user",
    navigationApprovalUrl?: string,
  ): Promise<BrowserNavigateResult> {
    const target = this.navigationTarget(tabId, "back");
    if (!target.ok) return target;
    return this.runHistoryAction(
      tabId,
      (host) => host.goBack({ agent: source === "agent", navigationApprovalUrl }),
      source,
      target.target.url,
      navigationApprovalUrl,
    );
  }

  /** 前进；无历史时返回错误。 */
  async goForward(
    tabId: number,
    source: BrowserOperationSource = "user",
    navigationApprovalUrl?: string,
  ): Promise<BrowserNavigateResult> {
    const target = this.navigationTarget(tabId, "forward");
    if (!target.ok) return target;
    return this.runHistoryAction(
      tabId,
      (host) => host.goForward({ agent: source === "agent", navigationApprovalUrl }),
      source,
      target.target.url,
      navigationApprovalUrl,
    );
  }

  async reload(tabId: number, source: BrowserOperationSource = "user"): Promise<BrowserNavigateResult> {
    return this.runHistoryAction(tabId, (host) => host.reload({ agent: source === "agent" }), source);
  }

  private async runHistoryAction(
    tabId: number,
    run: (host: BrowserHostController) => Promise<void>,
    _source: BrowserOperationSource,
    targetUrl?: string,
    navigationApprovalUrl?: string,
  ): Promise<BrowserNavigateResult> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (_source === "agent") this.activateAgentTab(tabId);
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
      await run(entry.host);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
    return { ok: true, tab: { ...entry.tab } };
  }

  /** 截取指定 tab 当前页面 PNG。 */
  async screenshot(tabId: number, source: BrowserOperationSource = "user"): Promise<BrowserScreenshotResult> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    if (source === "agent") this.activateAgentTab(tabId);
    if (source === "agent") {
      const policyError = this.blockedAgentSiteError(entry.tab.url);
      if (policyError !== null) return { ok: false, error: policyError };
    }
    try {
      const shot = await entry.host.captureScreenshot();
      return { ok: true, ...shot };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 清除整个持久分区的数据，即使当前没有已注册 tab。 */
  async clearData(): Promise<void> {
    await Promise.all([this.browserSession.clearStorageData(), this.browserSession.clearCache()]);
  }

  /** 访问历史（最近在前）；仅用户 UI 用，Agent 侧不可见（规范 §10.5）。 */
  browserHistory(): BrowserHistoryEntry[] {
    return this.history.map((entry) => ({ ...entry }));
  }

  /** 取视口坐标处元素（标注模式）：生成选择器与 bounds。 */
  async pickAnnotationTarget(tabId: number, x: number, y: number): Promise<BrowserAnnotationPickResult> {
    const entry = this.entries.get(tabId);
    if (!entry) return { ok: false, error: `tab ${tabId} 不存在` };
    if (entry.tab.crashed) return { ok: false, error: `tab ${tabId} 已崩溃，请重建后重试` };
    try {
      return await entry.host.pickElement(x, y);
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** 添加标注；返回完整标注对象。 */
  async addAnnotation(tabId: number, input: BrowserAnnotationInput): Promise<BrowserAnnotation | null> {
    const entry = this.entries.get(tabId);
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
    const list = this.annotationsByTab.get(tabId) ?? [];
    list.push(annotation);
    this.annotationsByTab.set(tabId, list);
    return { ...annotation };
  }

  /** 指定 tab 的标注列表（最近创建在前）。 */
  listAnnotations(tabId: number): BrowserAnnotation[] {
    return (this.annotationsByTab.get(tabId) ?? [])
      .slice()
      .reverse()
      .map((annotation) => ({ ...annotation, bounds: { ...annotation.bounds } }));
  }

  /** 删除标注；不存在时静默。 */
  async removeAnnotation(tabId: number, id: string): Promise<void> {
    const list = this.annotationsByTab.get(tabId);
    if (!list) return;
    const next = list.filter((annotation) => annotation.id !== id);
    if (next.length === 0) this.annotationsByTab.delete(tabId);
    else this.annotationsByTab.set(tabId, next);
  }

  /** 按选择器重新解析标注 bounds（导航/重绘后 overlay 重定位）；元素消失返回 null。 */
  async resolveAnnotationBounds(tabId: number, id: string): Promise<BrowserAnnotationBounds | null> {
    const annotation = (this.annotationsByTab.get(tabId) ?? []).find((item) => item.id === id);
    if (!annotation) return null;
    const entry = this.entries.get(tabId);
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
      for (const entry of this.entries.values()) entry.host.updateSettings(options);
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.browserSession.off("will-download", this.onWillDownload);
    for (const pending of this.pendingCreates.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("浏览器服务已关闭"));
    }
    this.pendingCreates.clear();
    for (const expiry of this.expiredCreateRequests.values()) clearTimeout(expiry);
    this.expiredCreateRequests.clear();
    for (const entry of this.entries.values()) entry.host.dispose();
    this.entries.clear();
    this.byWebContentsId.clear();
    this.activeTabId = null;
  }

  private activateAgentTab(tabId: number): void {
    if (this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.broadcast();
  }

  private handleHostEvent(tabId: number, event: BrowserHostEvent): void {
    const entry = this.entries.get(tabId);
    if (!entry || this.disposed) return;
    switch (event.type) {
      case "navigated":
        entry.tab.url = event.url;
        entry.tab.canGoBack = event.canGoBack;
        entry.tab.canGoForward = event.canGoForward;
        entry.tab.crashed = false;
        entry.tab.loadError = undefined;
        this.recordHistory(tabId, event.url, entry.tab.title);
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
        if (this.lastHistoryUrlByTab.get(tabId) === entry.tab.url) {
          const historyIndex = this.history.findIndex((item) => item.url === entry.tab.url);
          if (historyIndex !== -1) {
            this.history[historyIndex] = { ...this.history[historyIndex]!, title: event.title };
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
        this.removeEntry(tabId);
        return;
    }
    this.broadcast();
  }

  private removeEntry(tabId: number): void {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    this.entries.delete(tabId);
    this.byWebContentsId.delete(entry.webContentsId);
    this.lastHistoryUrlByTab.delete(tabId);
    this.annotationsByTab.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = [...this.entries.keys()][0] ?? null;
    }
    entry.host.dispose();
    this.broadcast();
  }

  /** 记录访问历史：同一 tab 重复导航同 URL 不重复；全局同 URL 合并并提前。 */
  private recordHistory(tabId: number, url: string, title: string): void {
    if (this.lastHistoryUrlByTab.get(tabId) === url) return;
    this.lastHistoryUrlByTab.set(tabId, url);
    const existing = this.history.findIndex((entry) => entry.url === url);
    if (existing !== -1) {
      const current = this.history.splice(existing, 1)[0]!;
      this.history.unshift({ url, title: title || current.title, timestamp: Date.now() });
      return;
    }
    this.history.unshift({ url, title, timestamp: Date.now() });
    if (this.history.length > MAX_HISTORY_ENTRIES) this.history.length = MAX_HISTORY_ENTRIES;
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
  private allowAgentNavigation(tabId: number, url: string, currentUrl: string, approvedUrl?: string): boolean {
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

  private broadcast(): void {
    if (this.disposed) return;
    this.options.onStateChanged?.({
      tabs: this.tabsList(),
      activeTabId: this.activeTabId,
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

function openTabTimeoutOf(options: BrowserManagerOptions): number {
  return options.openTabTimeoutMs ?? DEFAULT_OPEN_TAB_TIMEOUT_MS;
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
