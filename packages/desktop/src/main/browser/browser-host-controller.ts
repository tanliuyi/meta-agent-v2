/**
 * BrowserManager 的宿主控制器：封装对单个 guest webContents 的控制与事件桥接。
 *
 * P0 使用 webContents 原生 API（loadURL / capturePage / 生命周期事件）。
 * P1 增加 CDP 元素级交互（Accessibility.getFullAXTree 快照、Input 事件、
 * Runtime.evaluate），debugger 按需 attach，命令经串行队列执行。
 *
 * 本接口保持宿主无关（spec D1.1：若 webview 稳定性不可接受，迁移
 * WebContentsView 时只换实现）。
 */

import { clipboard as electronClipboard, type WebContents } from "electron";
import type {
  BrowserAction,
  BrowserActionTarget,
  BrowserAnnotationBounds,
  BrowserConsoleEntry,
  BrowserEvaluateResult,
  BrowserNavigationState,
  BrowserPendingDialog,
  BrowserSnapshot,
  BrowserSnapshotNode,
} from "../../shared/browser-contracts.ts";

/** 宿主向 BrowserManager 上报的浏览器事件（由 webContents 事件翻译而来）。 */
export type BrowserHostEvent =
  | { type: "navigated"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { type: "navigated-in-page"; url: string }
  | { type: "title-updated"; title: string }
  | { type: "loading-changed"; loading: boolean }
  | { type: "load-failed"; url: string; code: number; description: string }
  | { type: "crashed"; reason: string }
  | { type: "destroyed" };

/** Agent 点击/导航期间的同步导航守卫。返回 false 时，宿主必须阻止 will-navigate。 */
export type AgentNavigationGuard = (url: string, currentUrl: string, approvedUrl?: string) => boolean;

/** WebContentsHostController 的运行时配置。 */
export interface WebContentsHostControllerOptions {
  cdpTimeoutMs?: number;
  maxSnapshotNodes?: number;
  onAgentNavigation?: AgentNavigationGuard;
  onPopup?: (url: string) => void;
  onContextMenu?: (event: Electron.Event, params: Electron.ContextMenuParams) => void;
}

/** 宿主无关的浏览器控制接口（一个实例对应一个 tab 的 guest webContents）。 */
export interface BrowserHostController {
  navigate(url: string, options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  goBack(options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  goForward(options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  reload(options?: { agent?: boolean; navigationApprovalUrl?: string }): Promise<void>;
  getNavigationState(): BrowserNavigationState;
  captureScreenshot(options?: { fullPage?: boolean }): Promise<{ dataUrl: string; width: number; height: number }>;
  snapshot(opts: { withScreenshot: boolean }): Promise<BrowserSnapshot>;
  performAction(action: BrowserAction, options?: { agent?: boolean }): Promise<{ url?: string; title?: string }>;
  inspectElement(elementIndex: number): BrowserSnapshotNode | null;
  clearData(): Promise<void>;
  updateSettings(options: { cdpTimeoutMs: number; maxSnapshotNodes: number }): void;
  cancelPendingOperations(): void;
  /** 读取页面 console 日志（懒启用 Runtime 捕获；拉取即清空）。 */
  readConsoleLogs(options?: {
    filter?: string;
    levels?: BrowserConsoleEntry["level"][];
    limit?: number;
  }): Promise<BrowserConsoleEntry[]>;
  /** 当前挂起的 JS 对话框；无则 null。 */
  getPendingDialog(): BrowserPendingDialog | null;
  /** 响应挂起的 JS 对话框（accept/dismiss；prompt 可带输入文本）。 */
  handleDialog(action: "accept" | "dismiss", promptText?: string): Promise<void>;
  /** 在页面上下文执行 JS（awaitPromise + 序列化结果）。 */
  evaluate(expression: string): Promise<BrowserEvaluateResult>;
  /** 按键（组合键如 "Control+Enter"、"ControlOrMeta+KeyA"）。 */
  pressKey(keySequence: string): Promise<void>;
  /** 等待页面条件（load/timeout/url；对齐 Codex waitForLoadState/waitForTimeout/waitForURL）。 */
  waitFor(options: {
    state?: "load" | "domcontentloaded" | "networkidle";
    timeoutMs?: number;
    url?: string;
  }): Promise<void>;
  /** 读取最近 buffered 的 CDP 事件（对齐 Codex cdp.readEvents；拉取即清空）。 */
  readCdpEvents(options?: {
    methods?: string[];
    limit?: number;
  }): Promise<Array<{ method: string; params?: Record<string, unknown> }>>;
  /** 读剪贴板文本。 */
  clipboardReadText(): Promise<string>;
  /** 写剪贴板文本（虚拟剪贴板，不触发系统剪贴板快捷键冲突）。 */
  clipboardWriteText(text: string): Promise<void>;
  /** 按选择器执行元素操作（对齐 Codex PlaywrightLocator 核心命令集）。
   *  by: 定位方式（css/role/text/label/placeholder/testid，缺省 css）；byValue 与 by 搭配；
   *  frame: iframe 的 CSS 选择器（同源内查找）；nth: 第 N 个匹配（缺省 0）。 */
  locatorAction(
    selector: string,
    action:
      | "click"
      | "fill"
      | "press"
      | "select"
      | "check"
      | "uncheck"
      | "text"
      | "innerText"
      | "attribute"
      | "count"
      | "visible"
      | "enabled"
      | "info"
      | "screenshot",
    params?: {
      value?: string;
      attribute?: string;
      by?: "css" | "role" | "text" | "label" | "placeholder" | "testid";
      byValue?: string;
      frame?: string;
      nth?: number;
    },
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
  >;
  /** 文件上传（对齐 Codex PlaywrightFileChooser.setFiles）。 */
  uploadFile(selector: string, filePath: string): Promise<void>;
  /** 坐标点击（对齐 Codex CUA clickPoint）。 */
  clickPoint(x: number, y: number, keys?: string[]): Promise<void>;
  /** 原始 CDP 命令（对齐 Codex cdp.send；返回序列化结果或错误描述）。 */
  cdpSend(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** 等待下一次导航完成（对齐 Codex expectNavigation）。 */
  expectNavigation(timeoutMs?: number): Promise<void>;
  /** 拖拽：沿坐标路径移动鼠标（对齐 Codex CUA drag）。 */
  dragPath(points: Array<{ x: number; y: number }>): Promise<void>;
  /** 移动鼠标到坐标（对齐 Codex CUA move）。 */
  moveMouse(x: number, y: number): Promise<void>;
  /** 坐标双击（对齐 Codex CUA double_click）。 */
  dblclickPoint(x: number, y: number): Promise<void>;
  /** 导出页面主文本（对齐 Codex ContentAPI.export；article/main/body innerText，截断）。 */
  contentExport(): Promise<string>;
  /** 最近下载记录（监听 session will-download；最多保留 50 条）。 */
  downloadEvents(): Promise<Array<{ url: string; filename: string; path: string | null }>>;
  /** 触发下载并保存到指定路径（对齐 Codex downloadMedia）。 */
  downloadMedia(url: string, savePath: string): Promise<void>;
  /** 取视口 (x,y) 处元素：生成稳定 CSS 选择器并返回其 bounds（标注模式用）。 */
  pickElement(x: number, y: number): Promise<PickElementResult>;
  /** 按选择器解析元素当前 bounds；元素不存在时返回 null（标注导航后重定位）。 */
  resolveSelectorBounds(selector: string): Promise<BrowserAnnotationBounds | null>;
  dispose(): void;
  onEvent(cb: (event: BrowserHostEvent) => void): () => void;
}

/** pickElement 结果：成功时含选择器与元素信息。 */
export type PickElementResult =
  | { ok: true; selector: string; bounds: BrowserAnnotationBounds; tag: string; name: string }
  | { ok: false; error: string };

/** 元素编号在最近一次 snapshot 后失效（页面导航/重绘）。 */
export class StaleReferenceError extends Error {
  constructor(message = "元素引用已失效，请重新获取页面快照") {
    super(message);
    this.name = "StaleReferenceError";
  }
}

const DEFAULT_CDP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SNAPSHOT_NODES = 200;
const AGENT_NAVIGATION_GUARD_WINDOW_MS = 5_000;
const HISTORY_NAVIGATION_TIMEOUT_MS = 30_000;
const NAME_MAX_CHARS = 120;

/** 可交互元素角色：这些节点会被编号供模型引用。 */
const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "switch"]);

/** CDP Accessibility.getFullAXTree 返回的节点子集。 */
export interface CdpAxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { type?: string; value?: unknown } }>;
  boundingBox?: { x?: number; y?: number; width?: number; height?: number };
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** 交互元素 DOM 描述：标签、关键属性与稳定选择器（与标注拾取同算法）。 */
export interface InteractiveDomInfo {
  tag: string;
  attrs: BrowserSnapshotNode["attrs"];
  /** 页面内生成的稳定 CSS 选择器（模型可对照标注引用定位元素）。 */
  selector?: string;
}

export interface InteractiveElement {
  index: number;
  center: { x: number; y: number };
  backendDOMNodeId?: number;
  snapshotNode?: BrowserSnapshotNode;
  fingerprint?: Omit<BrowserActionTarget, "pageUrl">;
}

interface LiveTarget {
  tag: string;
  name: string;
  selector: string;
  attrs?: BrowserSnapshotNode["attrs"];
}

/** 基于 Electron webContents 原生 API + CDP 的宿主实现。 */
export class WebContentsHostController implements BrowserHostController {
  private readonly webContents: WebContents;
  private readonly listeners: Array<() => void> = [];
  private readonly eventListeners = new Set<(event: BrowserHostEvent) => void>();
  private cdpTimeoutMs: number;
  private maxSnapshotNodes: number;
  private readonly onAgentNavigation?: AgentNavigationGuard;
  private readonly onPopup?: (url: string) => void;
  private readonly onContextMenu?: (event: Electron.Event, params: Electron.ContextMenuParams) => void;
  /** 命令串行队列：同一 tab 内 CDP 命令逐个执行。 */
  private cdpQueue: Promise<void> = Promise.resolve();
  private debuggerAttached = false;
  private domDomainEnabled = false;
  private cdpMessageListenerRegistered = false;
  private operationGeneration = 0;
  private agentNavigationGuard: { approvedUrl?: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 最近一次被导航守卫拦截的 URL（agent 导航/点击后消费，用于友好错误分类）。 */
  private lastNavigationBlocked: { url: string; reason: "cross-site-redirect" | "not-approved" } | null = null;
  /** 最近一次 snapshot 的可交互元素编号 → 中心坐标。 */
  private interactiveByIndex = new Map<number, InteractiveElement>();
  /** console 捕获缓冲（对齐 Codex tab_dev_logs：懒启用 Runtime 后累积）。 */
  private consoleLogBuffer: BrowserConsoleEntry[] = [];
  private consoleCaptureEnabled = false;
  /** CDP 事件缓冲（对齐 Codex cdp.readEvents：readCdpEvents 拉取即清空）。 */
  private cdpEventBuffer: Array<{ method: string; params?: Record<string, unknown> }> = [];
  /** 下载记录缓冲（监听 session will-download；最多 50 条）。 */
  private downloadEventsBuffer: Array<{ url: string; filename: string; path: string | null }> = [];
  /** downloadMedia 指定的保存路径（下一次 will-download 消费）。 */
  private pendingDownloadSavePath: string | null = null;
  /** 挂起的 JS 对话框（Page.javascriptDialogOpening 捕获）。 */
  private pendingDialog: BrowserPendingDialog | null = null;

  constructor(webContents: WebContents, options: WebContentsHostControllerOptions = {}) {
    this.webContents = webContents;
    this.cdpTimeoutMs = options.cdpTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    this.maxSnapshotNodes = options.maxSnapshotNodes ?? DEFAULT_MAX_SNAPSHOT_NODES;
    this.onAgentNavigation = options.onAgentNavigation;
    this.onPopup = options.onPopup;
    this.onContextMenu = options.onContextMenu;
    this.bindEvents();
    this.bindWindowOpenHandler();
    // 记录会话内下载（对齐 Codex downloadMedia；dispose 时清理）。
    const recordDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
      if (this.pendingDownloadSavePath !== null) {
        try {
          item.setSavePath(this.pendingDownloadSavePath);
        } catch {
          // 路径非法时回退默认行为。
        }
        this.pendingDownloadSavePath = null;
      }
      const makeRecord = (): { url: string; filename: string; path: string | null } => {
        let savePath: string | null = null;
        try {
          savePath = item.getSavePath();
        } catch {
          savePath = null;
        }
        return { url: item.getURL(), filename: item.getFilename(), path: savePath };
      };
      const pushRecord = (record: { url: string; filename: string; path: string | null }): void => {
        this.downloadEventsBuffer.push(record);
        if (this.downloadEventsBuffer.length > 50) {
          this.downloadEventsBuffer.splice(0, this.downloadEventsBuffer.length - 50);
        }
      };
      // 先记录初始状态；done 后用最终 savePath 更新同 url 的最后一条（不重复追加）。
      item.once("done", () => {
        const record = makeRecord();
        const index = [...this.downloadEventsBuffer].reverse().findIndex((entry) => entry.url === record.url);
        if (index >= 0) {
          const at = this.downloadEventsBuffer.length - 1 - index;
          this.downloadEventsBuffer[at] = record;
        } else {
          pushRecord(record);
        }
      });
      pushRecord(makeRecord());
    };
    this.webContents.session?.on("will-download", recordDownload);
    this.listeners.push(() => {
      this.webContents.session?.off("will-download", recordDownload);
    });
  }

  async navigate(url: string, options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    if (options.agent) this.beginAgentNavigationGuard(options.navigationApprovalUrl);
    try {
      await this.webContents.loadURL(url);
    } catch (error) {
      if (options.agent) this.clearAgentNavigationGuard();
      const blocked = this.consumeNavigationBlocked();
      if (blocked) throw new Error(this.describeNavigationBlocked(blocked));
      throw error;
    }
  }

  /** 读取并消费最近一次守卫拦截记录（导航失败时用于区分安全拦截与网络错误）。 */
  consumeNavigationBlocked(): { url: string; reason: "cross-site-redirect" | "not-approved" } | null {
    const blocked = this.lastNavigationBlocked;
    this.lastNavigationBlocked = null;
    return blocked;
  }

  /** 守卫拦截的友好错误文案（区分跨站重定向与未批准站点）。 */
  describeNavigationBlocked(blocked: { url: string; reason: "cross-site-redirect" | "not-approved" }): string {
    const host = httpUrlHost(blocked.url) ?? blocked.url;
    return blocked.reason === "cross-site-redirect"
      ? `导航被拦截：目标页面重定向到未批准的站点（${host}），需要重新确认该站点`
      : `导航被拦截：站点 ${host} 未获批准，无法导航`;
  }

  getNavigationState(): BrowserNavigationState {
    const history = this.webContents.navigationHistory;
    return {
      activeIndex: history.getActiveIndex(),
      entries: history.getAllEntries().map((entry) => ({ url: entry.url, title: entry.title })),
    };
  }

  goBack(options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    return this.runHistoryNavigation(() => this.webContents.navigationHistory.goBack(), options);
  }

  goForward(options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    return this.runHistoryNavigation(() => this.webContents.navigationHistory.goForward(), options);
  }

  reload(options: { agent?: boolean; navigationApprovalUrl?: string } = {}): Promise<void> {
    return this.runHistoryNavigation(() => this.webContents.reload(), options);
  }

  private runHistoryNavigation(
    start: () => void,
    options: { agent?: boolean; navigationApprovalUrl?: string },
  ): Promise<void> {
    if (options.agent) this.beginAgentNavigationGuard(options.navigationApprovalUrl);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onNavigate = (): void => finish();
      const onNavigateInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
        if (isMainFrame) finish();
      };
      const onFailLoad = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ): void => {
        if (!isMainFrame || errorCode === -3) return;
        finish(new Error(`导航失败（${errorCode}）：${errorDescription}`));
      };
      const timer = setTimeout(
        () => finish(new Error(`历史导航超时（${HISTORY_NAVIGATION_TIMEOUT_MS}ms）`)),
        HISTORY_NAVIGATION_TIMEOUT_MS,
      );
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.webContents.removeListener("did-navigate", onNavigate);
        this.webContents.removeListener("did-navigate-in-page", onNavigateInPage);
        this.webContents.removeListener("did-fail-load", onFailLoad);
        if (options.agent && error) this.clearAgentNavigationGuard();
        if (error) reject(error);
        else resolve();
      };
      this.webContents.once("did-navigate", onNavigate);
      this.webContents.once("did-navigate-in-page", onNavigateInPage);
      this.webContents.on("did-fail-load", onFailLoad);
      try {
        start();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async captureScreenshot(
    options: { fullPage?: boolean } = {},
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    // 统一走 CDP Page.captureScreenshot：fromSurface:false 从内存主帧捕获，
    // 后台/屏幕外/非活跃标签页（guest 被 Chromium occlusion 后台化）也能实时截图，
    // 不依赖屏幕合成（Electron capturePage 在不可见时会挂起）。
    const result = (await withTimeout(
      this.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: false,
        ...(options.fullPage === true ? { captureBeyondViewport: true } : {}),
      }),
      5_000,
      () => undefined,
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("超时")) {
        throw new Error("页面截图超时（CDP captureScreenshot 无响应）");
      }
      throw error;
    })) as { data?: string };
    if (typeof result.data !== "string" || result.data.length === 0) {
      throw new Error("页面截图失败：图像为空");
    }
    const { width, height } = pngDimensions(result.data);
    return { dataUrl: `data:image/png;base64,${result.data}`, width, height };
  }

  /** 读取页面 console 日志：懒启用 Runtime 捕获（对齐 Codex tab_dev_logs），拉取即清空。 */
  async readConsoleLogs(
    options: { filter?: string; levels?: BrowserConsoleEntry["level"][]; limit?: number } = {},
  ): Promise<BrowserConsoleEntry[]> {
    await this.ensureConsoleCapture();
    const levelSet = options.levels ? new Set(options.levels) : null;
    const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 100;
    const matching = this.consoleLogBuffer.filter(
      (entry) =>
        !(options.filter && !entry.message.includes(options.filter)) && !(levelSet && !levelSet.has(entry.level)),
    );
    const result = matching.slice(-limit);
    this.consoleLogBuffer = [];
    return result;
  }

  /** 当前挂起的 JS 对话框；无则 null。 */
  getPendingDialog(): BrowserPendingDialog | null {
    return this.pendingDialog;
  }

  /** 响应挂起的 JS 对话框（Page.handleJavaScriptDialog）。 */
  async handleDialog(action: "accept" | "dismiss", promptText?: string): Promise<void> {
    if (this.pendingDialog === null) throw new Error("当前没有挂起的 JS 对话框");
    if (action === "accept" && this.pendingDialog.type === "prompt" && promptText === undefined) {
      throw new Error("prompt 对话框需要提供输入文本");
    }
    const params: Record<string, unknown> = { accept: action === "accept" };
    if (action === "accept" && promptText !== undefined) params.promptText = promptText;
    await this.sendCommand("Page.handleJavaScriptDialog", params);
    this.pendingDialog = null;
  }

  /** 在页面上下文执行 JS（awaitPromise + returnByValue 序列化）。 */
  async evaluate(expression: string): Promise<BrowserEvaluateResult> {
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { type?: string; value?: unknown; description?: string }; exceptionDetails?: unknown };
    if (response.exceptionDetails) {
      const details = response.exceptionDetails as { text?: string; exception?: { description?: string } };
      const message = details.exception?.description ?? details.text ?? "JS 执行异常";
      return { ok: false, error: message };
    }
    const type = response.result?.type ?? "undefined";
    let value = "undefined";
    if (type === "undefined") {
      value = "undefined";
    } else if (type === "object" && response.result?.value === undefined) {
      value = response.result?.description ?? "[object]";
    } else {
      try {
        value = JSON.stringify(response.result?.value, null, 2) ?? String(response.result?.value);
      } catch {
        value = String(response.result?.value);
      }
    }
    // 结果防刷屏截断（对齐 Codex 的 payload 限制）。
    if (value.length > 100_000) value = `${value.slice(0, 100_000)}…（已截断）`;
    return { ok: true, value, type };
  }

  /** 等待页面条件（对齐 Codex waitForLoadState/waitForTimeout/waitForURL）。 */
  async waitFor(
    options: { state?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number; url?: string } = {},
  ): Promise<void> {
    if (options.timeoutMs !== undefined) {
      if (options.timeoutMs <= 0) throw new Error("timeoutMs 必须为正数");
      await new Promise((resolve) => setTimeout(resolve, options.timeoutMs));
      return;
    }
    if (options.url !== undefined) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const current = this.webContents.getURL();
        if (current === options.url || current.startsWith(options.url)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`等待 URL 超时：${options.url}（当前 ${this.webContents.getURL()}）`);
    }
    if (options.state !== undefined) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = (await this.sendCommand("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        })) as { result?: { value?: string } };
        const readyState = status.result?.value ?? "";
        let satisfied =
          options.state === "domcontentloaded"
            ? readyState === "interactive" || readyState === "complete"
            : readyState === "complete";
        if (satisfied && options.state === "networkidle") {
          // networkidle 近似：complete + 最近 500ms 无资源加载（performance entries）。
          const idle = (await this.sendCommand("Runtime.evaluate", {
            expression: `(() => { const entries = performance.getEntriesByType('resource'); if (entries.length === 0) return true; const last = entries[entries.length - 1]; return Date.now() - (last.responseEnd || 0) > 500; })()`,
            returnByValue: true,
          })) as { result?: { value?: boolean } };
          satisfied = idle.result?.value === true;
        }
        if (satisfied) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`等待加载状态超时：${options.state}`);
    }
  }

  /** 触发下载并保存到指定路径（对齐 Codex downloadMedia）。 */
  async downloadMedia(url: string, savePath: string): Promise<void> {
    if (!/^https?:/i.test(url)) throw new Error("仅支持 http/https 下载链接");
    this.pendingDownloadSavePath = savePath;
    this.webContents.downloadURL(url);
  }

  /** 读取缓冲的 CDP 事件（对齐 Codex cdp.readEvents；拉取即清空，可按方法过滤）。 */
  async readCdpEvents(
    options: { methods?: string[]; limit?: number } = {},
  ): Promise<Array<{ method: string; params?: Record<string, unknown> }>> {
    const methodSet = options.methods ? new Set(options.methods) : null;
    const limit = typeof options.limit === "number" && options.limit > 0 ? options.limit : 100;
    const matching = this.cdpEventBuffer.filter((event) => !(methodSet && !methodSet.has(event.method)));
    const result = matching.slice(-limit);
    this.cdpEventBuffer = [];
    return result;
  }

  /** 读剪贴板文本（Electron 系统剪贴板：页面 navigator.clipboard 受权限 handler 限制不可用）。 */
  async clipboardReadText(): Promise<string> {
    return electronClipboard.readText();
  }

  /** 写剪贴板文本（Electron 系统剪贴板；webview 内粘贴事件由 Electron 处理）。 */
  async clipboardWriteText(text: string): Promise<void> {
    electronClipboard.writeText(text);
  }

  /** 按选择器执行元素操作（对齐 Codex PlaywrightLocator 核心命令集）。 */
  async locatorAction(
    selector: string,
    action:
      | "click"
      | "fill"
      | "press"
      | "select"
      | "check"
      | "uncheck"
      | "text"
      | "innerText"
      | "attribute"
      | "count"
      | "visible"
      | "enabled"
      | "info"
      | "screenshot",
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
    if (selector.trim().length === 0) return { ok: false, error: "selector 不能为空" };
    const elExpr = buildElementQuery(selector, params);
    // 只读操作：直接 evaluate。
    if (action === "count") {
      const countExpr = buildElementCountQuery(selector, params);
      const response = (await this.sendCommand("Runtime.evaluate", {
        expression: countExpr,
        returnByValue: true,
      })) as { result?: { value?: number } };
      return { ok: true, count: response.result?.value ?? 0 };
    }
    if (action === "visible" || action === "enabled") {
      const expression =
        action === "visible"
          ? `(() => { const el = ${elExpr}; if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`
          : `(() => { const el = ${elExpr}; return el ? !el.disabled : false; })()`;
      const response = (await this.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result?: { value?: boolean } };
      return action === "visible"
        ? { ok: true, visible: response.result?.value ?? false }
        : { ok: true, enabled: response.result?.value ?? false };
    }
    if (action === "text" || action === "innerText" || action === "attribute") {
      const property = action === "attribute" ? "getAttribute(attr)" : action === "text" ? "textContent" : "innerText";
      const expression =
        action === "attribute"
          ? `(() => { const el = ${elExpr}; return el ? (el.getAttribute(${JSON.stringify(params.attribute ?? "")}) ?? null) : null; })()`
          : `(() => { const el = ${elExpr}; return el ? el.${property} ?? null : null; })()`;
      const response = (await this.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result?: { value?: string | null } };
      return { ok: true, value: response.result?.value ?? undefined };
    }
    if (action === "info") {
      const expression = `(() => { const el = ${elExpr}; if (!el) return null; const r = el.getBoundingClientRect(); const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value; return { tag: el.tagName, attrs, text: el.textContent ?? '', visible: r.width > 0 && r.height > 0, enabled: !el.disabled, bounds: { x: r.x, y: r.y, width: r.width, height: r.height } }; })()`;
      const response = (await this.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })) as { result?: { value?: Record<string, unknown> | null } };
      if (response.result?.value === undefined || response.result?.value === null) {
        return { ok: false, error: `未找到元素: ${selector}` };
      }
      return { ok: true, info: response.result.value };
    }
    if (action === "select") {
      if (params.value === undefined) return { ok: false, error: "select 需要提供 value" };
      const response = (await this.sendCommand("Runtime.evaluate", {
        expression: `(() => { const el = ${elExpr}; if (!el || el.tagName !== 'SELECT') return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(params.value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        returnByValue: true,
      })) as { result?: { value?: boolean } };
      if (response.result?.value !== true) return { ok: false, error: `未找到 select 元素: ${selector}` };
      return { ok: true };
    }
    // 交互类 / screenshot：先解析元素坐标与边界（真实鼠标事件）。
    const rect = (await this.sendCommand("Runtime.evaluate", {
      expression: `(() => { const el = ${elExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, l: r.left, t: r.top }; })()`,
      returnByValue: true,
    })) as { result?: { value?: { x: number; y: number; w: number; h: number; l: number; t: number } | null } };
    const point = rect.result?.value;
    if (!point) return { ok: false, error: `未找到元素: ${selector}` };
    if (point.w <= 0 || point.h <= 0) return { ok: false, error: `元素不可见（尺寸为 0）: ${selector}` };
    if (action === "screenshot") {
      // 按元素边界裁剪截图（对齐 Codex elementScreenshot）。
      const shot = (await this.sendCommand("Page.captureScreenshot", {
        format: "png",
        clip: { x: point.l, y: point.t, width: point.w, height: point.h, scale: 1 },
      })) as { data?: string };
      if (typeof shot.data !== "string" || shot.data.length === 0) {
        return { ok: false, error: "元素截图失败：图像为空" };
      }
      const { width, height } = pngDimensions(shot.data);
      return { ok: true, screenshot: { dataUrl: `data:image/png;base64,${shot.data}`, width, height } };
    }
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    if (action === "click" || action === "check" || action === "uncheck") {
      if (action !== "click") {
        // check/uncheck：点击后若状态不符再点一次（近似对齐 Playwright check）。
        const current = (await this.sendCommand("Runtime.evaluate", {
          expression: `(() => { const el = ${elExpr}; return el ? el.checked === true : false; })()`,
          returnByValue: true,
        })) as { result?: { value?: boolean } };
        const want = action === "check";
        if (current.result?.value !== want) {
          await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
          await this.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: point.x,
            y: point.y,
            button: "left",
            clickCount: 1,
          });
        }
      }
      return { ok: true };
    }
    if (action === "fill") {
      if (params.value === undefined) return { ok: false, error: "fill 需要提供 value" };
      await this.sendCommand("Runtime.evaluate", {
        expression: `(() => { const el = document.activeElement; if (el && typeof el.select === 'function') el.select(); return true; })()`,
        returnByValue: true,
      });
      await this.sendCommand("Input.insertText", { text: params.value });
      return { ok: true };
    }
    if (action === "press") {
      if (params.value === undefined) return { ok: false, error: "press 需要提供 key" };
      // 对齐 Playwright locator.press：先聚焦目标元素再按键。
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await this.pressKey(params.value);
      return { ok: true };
    }
    return { ok: false, error: `不支持的操作: ${action}` };
  }

  /** 原始 CDP 命令（对齐 Codex cdp.send；返回序列化结果或错误描述）。 */
  async cdpSend(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const result = await this.sendCommand(method, params ?? {});
    const exception = (result as { exceptionDetails?: unknown } | null)?.exceptionDetails;
    if (exception) {
      const details = exception as { text?: string; exception?: { description?: string } };
      return { error: details.exception?.description ?? details.text ?? "CDP 命令异常" };
    }
    return result;
  }

  /** 等待下一次导航完成（对齐 Codex expectNavigation）。 */
  async expectNavigation(timeoutMs?: number): Promise<void> {
    const startedUrl = this.webContents.getURL();
    const deadline = Date.now() + (typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 10_000);
    while (Date.now() < deadline) {
      const current = this.webContents.getURL();
      if (current !== startedUrl && !this.webContents.isLoading()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`等待导航超时（当前 ${this.webContents.getURL()}）`);
  }

  /** 拖拽：沿坐标路径移动鼠标（对齐 Codex CUA drag）。 */
  async dragPath(points: Array<{ x: number; y: number }>): Promise<void> {
    if (points.length < 2) throw new Error("dragPath 需要至少 2 个坐标点");
    const [first] = points;
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: first!.x,
      y: first!.y,
      button: "left",
      clickCount: 1,
    });
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index]!;
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
      });
    }
    const last = points[points.length - 1]!;
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
    });
  }

  /** 移动鼠标到坐标（对齐 Codex CUA move）。 */
  async moveMouse(x: number, y: number): Promise<void> {
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
  }

  /** 坐标双击（对齐 Codex CUA double_click）。 */
  async dblclickPoint(x: number, y: number): Promise<void> {
    for (const clickCount of [1, 2] as const) {
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount,
      });
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount,
      });
    }
  }

  /** 导出页面主文本（对齐 Codex ContentAPI.export；article/main/body innerText，截断）。 */
  async contentExport(): Promise<string> {
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression:
        "document.querySelector('article')?.innerText ?? document.querySelector('main')?.innerText ?? document.body?.innerText ?? ''",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const text = response.result?.value ?? "";
    return text.length > 100_000 ? `${text.slice(0, 100_000)}…（已截断）` : text;
  }

  /** 最近下载记录（监听 session will-download；最多保留 50 条）。 */
  async downloadEvents(): Promise<Array<{ url: string; filename: string; path: string | null }>> {
    return [...this.downloadEventsBuffer];
  }

  /** 文件上传（对齐 Codex PlaywrightFileChooser.setFiles；DOM.setFileInputFiles）。 */
  async uploadFile(selector: string, filePath: string): Promise<void> {
    const doc = (await this.sendCommand("DOM.getDocument", { depth: -1 })) as { root?: { nodeId?: number } };
    if (!doc.root?.nodeId) throw new Error("无法获取页面 DOM 根节点");
    const found = (await this.sendCommand("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    })) as { nodeId?: number };
    if (!found.nodeId || found.nodeId === 0) throw new Error(`未找到文件输入元素: ${selector}`);
    await this.sendCommand("DOM.setFileInputFiles", { nodeId: found.nodeId, files: [filePath] });
  }

  /** 坐标点击（对齐 Codex CUA clickPoint：真实鼠标事件 + 修饰键）。 */
  async clickPoint(x: number, y: number, keys?: string[]): Promise<void> {
    let modifiers = 0;
    for (const key of keys ?? []) {
      const bit = CDP_MODIFIER_BITS[resolveModifier(key)];
      if (bit === undefined) throw new Error(`未知修饰键: ${key}`);
      modifiers |= bit;
    }
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
      modifiers,
    });
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
      modifiers,
    });
  }

  /** 结构化页面快照：AX 树简化 + 可交互元素编号 + 可选截图。 */
  async snapshot(opts: { withScreenshot: boolean }): Promise<BrowserSnapshot> {
    const [tree, viewport, screenshot] = await Promise.all([
      this.runCdp(() => this.buildSnapshotTree()),
      this.runCdp(() => this.evaluateViewport()),
      opts.withScreenshot ? this.runCdp(() => this.captureCdpScreenshot()) : Promise.resolve(null),
    ]);
    return {
      url: this.webContents.getURL(),
      title: this.webContents.getTitle(),
      timestamp: Date.now(),
      viewport,
      tree,
      screenshot,
    };
  }

  /** 元素级交互（click/type/scroll），编号来自最近一次 snapshot。 */
  async performAction(
    action: BrowserAction,
    options: { agent?: boolean } = {},
  ): Promise<{ url?: string; title?: string }> {
    return this.runCdp(async () => {
      if (options.agent)
        this.beginAgentNavigationGuard(action.type === "click" ? action.navigationApprovalUrl : undefined);
      try {
        switch (action.type) {
          case "click":
            await this.clickElement(action.elementIndex, action.target);
            break;
          case "type":
            await this.typeText(
              action.elementIndex,
              action.text,
              action.submit === true,
              action.replace === true,
              action.target,
            );
            break;
          case "scroll":
            await this.scrollPage(action.direction, action.amount);
            break;
          default:
            throw new Error(`未知浏览器操作类型: ${String((action as { type?: unknown }).type)}`);
        }
        const blocked = this.consumeNavigationBlocked();
        return {
          url: this.webContents.getURL() || undefined,
          title: this.webContents.getTitle() || undefined,
          ...(blocked ? { navigationBlocked: this.describeNavigationBlocked(blocked) } : {}),
        };
      } finally {
        // 任何页面动作都使旧编号失效；事件导航也会清空，但 DOM 重排不一定触发导航。
        this.interactiveByIndex.clear();
        if (options.agent) this.scheduleAgentNavigationGuardClear();
      }
    });
  }

  inspectElement(elementIndex: number): BrowserSnapshotNode | null {
    const element = this.interactiveByIndex.get(elementIndex);
    if (!element?.snapshotNode) return null;
    return {
      ...element.snapshotNode,
      ...(element.snapshotNode.attrs ? { attrs: { ...element.snapshotNode.attrs } } : {}),
    };
  }

  clearData(): Promise<void> {
    return this.webContents.session.clearStorageData();
  }

  updateSettings(options: { cdpTimeoutMs: number; maxSnapshotNodes: number }): void {
    this.cdpTimeoutMs = options.cdpTimeoutMs;
    this.maxSnapshotNodes = options.maxSnapshotNodes;
    this.interactiveByIndex.clear();
  }

  /** 取消当前 CDP/导航操作，并让迟到的命令结果失效。 */
  cancelPendingOperations(): void {
    this.operationGeneration += 1;
    this.interactiveByIndex.clear();
    this.clearAgentNavigationGuard();
    try {
      this.webContents.stop();
    } catch {
      // guest 已销毁或尚未 attach 时停止可能失败。
    }
    this.detachDebugger();
  }

  /** 取视口坐标处元素（标注模式）：经 Runtime.evaluate 在页面内生成稳定选择器。 */
  async pickElement(x: number, y: number): Promise<PickElementResult> {
    return this.runCdp(() => this.pickElementInternal(x, y));
  }

  private async pickElementInternal(x: number, y: number): Promise<PickElementResult> {
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression: PICK_ELEMENT_SCRIPT.replace("__X__", String(x)).replace("__Y__", String(y)),
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = response.result?.value as
      | { error?: string; selector?: string; bounds?: BrowserAnnotationBounds; tag?: string; name?: string }
      | undefined;
    if (!value || typeof value !== "object") return { ok: false, error: "无法解析页面元素" };
    if (value.error !== undefined) return { ok: false, error: value.error };
    if (typeof value.selector !== "string" || !value.bounds) return { ok: false, error: "元素选择器生成失败" };
    return {
      ok: true,
      selector: value.selector,
      bounds: value.bounds,
      tag: value.tag ?? "",
      name: value.name ?? "",
    };
  }

  /** 按选择器解析元素当前 bounds（导航后标注重定位）；不存在返回 null。 */
  async resolveSelectorBounds(selector: string): Promise<BrowserAnnotationBounds | null> {
    return this.runCdp(() => this.resolveSelectorBoundsInternal(selector));
  }

  private async resolveSelectorBoundsInternal(selector: string): Promise<BrowserAnnotationBounds | null> {
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`;
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = response.result?.value as
      | { x?: number; y?: number; width?: number; height?: number }
      | null
      | undefined;
    if (!value || typeof value !== "object") return null;
    if (
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      typeof value.height !== "number"
    ) {
      return null;
    }
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }

  dispose(): void {
    this.cancelPendingOperations();
    for (const remove of this.listeners.splice(0)) {
      try {
        remove();
      } catch {
        // guest webContents 已销毁时，事件解绑（off）可能抛 "Object has been destroyed"。
      }
    }
    this.eventListeners.clear();
    this.interactiveByIndex.clear();
    this.downloadEventsBuffer.length = 0;
    this.detachDebugger();
  }

  onEvent(cb: (event: BrowserHostEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  /** 把操作排入串行队列并带超时执行；超时会取消当前代次。 */
  private runCdp<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.operationGeneration;
    let underlying: Promise<T> | undefined;
    const start = () => {
      if (generation !== this.operationGeneration) return Promise.reject(new Error("CDP 操作已取消"));
      underlying = Promise.resolve().then(operation);
      return withTimeout(underlying, this.cdpTimeoutMs, () => this.cancelPendingOperations());
    };
    const run = this.cdpQueue.then(start, start);
    // 超时只让调用方尽快得到错误；队列仍等待底层 sendCommand 结束，避免
    // detach 后迟到的旧命令与新一代命令并发使用同一个 debugger transport。
    this.cdpQueue = run.then(
      () =>
        underlying?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve(),
      () =>
        underlying?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve(),
    );
    return run;
  }

  private ensureDebugger(): void {
    if (this.debuggerAttached) return;
    try {
      this.webContents.debugger.attach("1.3");
      this.debuggerAttached = true;
      this.webContents.debugger.once("detach", () => {
        this.debuggerAttached = false;
        this.domDomainEnabled = false;
        this.consoleCaptureEnabled = false;
        this.pendingDialog = null;
      });
      if (!this.cdpMessageListenerRegistered) {
        this.cdpMessageListenerRegistered = true;
        this.webContents.debugger.on("message", (_event, method, params) => {
          this.recordConsoleEvent(method, params as Record<string, unknown>);
          this.recordDialogEvent(method, params as Record<string, unknown>);
          // 除高频渲染事件外缓冲 CDP 事件（对齐 Codex readEvents）。
          if (!IGNORED_CDP_EVENTS.has(method)) {
            this.cdpEventBuffer.push({ method, params: params as Record<string, unknown> });
          }
        });
      }
      // 尽早启用事件域：console 捕获与 JS 对话框（每次 attach 后重新启用）。
      void this.sendCommand("Runtime.enable", {}).catch(() => undefined);
      void this.sendCommand("Log.enable", {}).catch(() => undefined);
      void this.sendCommand("Page.enable", {}).catch(() => undefined);
    } catch (error) {
      this.debuggerAttached = false;
      this.domDomainEnabled = false;
      throw new Error(`CDP attach 失败: ${messageOf(error)}`);
    }
  }

  private detachDebugger(): void {
    if (!this.debuggerAttached) return;
    try {
      this.webContents.debugger.detach();
    } catch {
      // guest 已销毁等场景下 detach 失败可忽略。
    }
    this.debuggerAttached = false;
    this.domDomainEnabled = false;
  }

  private async sendCommand(method: string, params?: unknown): Promise<unknown> {
    const generation = this.operationGeneration;
    this.ensureDebugger();
    if (!this.domDomainEnabled && method !== "DOM.enable") {
      await this.webContents.debugger.sendCommand("DOM.enable", {});
      if (generation !== this.operationGeneration) throw new Error("CDP 操作已取消");
      this.domDomainEnabled = true;
    }
    const result = await this.webContents.debugger.sendCommand(method, params as Record<string, unknown>);
    if (generation !== this.operationGeneration) throw new Error("CDP 操作已取消");
    return result;
  }

  private async buildSnapshotTree(): Promise<BrowserSnapshotNode[]> {
    const viewport = await this.evaluateViewport();
    const response = (await this.sendCommand("Accessibility.getFullAXTree")) as { nodes?: CdpAxNode[] };
    const nodes = response.nodes ?? [];
    if (nodes.length === 0) return [];

    const byId = new Map<string, CdpAxNode>();
    const referenced = new Set<string>();
    const interactiveNodes = collectInteractive(nodes, viewport);
    const boundsByNodeId = await this.resolveInteractiveBounds(interactiveNodes);
    const normalizedNodes = nodes.map((node) => {
      const bounds = node.nodeId ? boundsByNodeId.get(node.nodeId) : undefined;
      return bounds ? { ...node, boundingBox: bounds } : node;
    });
    for (const node of normalizedNodes) {
      if (node.nodeId) byId.set(node.nodeId, node);
    }
    for (const node of normalizedNodes) {
      for (const childId of node.childIds ?? []) referenced.add(childId);
    }
    const roots = normalizedNodes.filter((node) => node.nodeId && !referenced.has(node.nodeId));

    // 可交互节点的 DOM 信息（标签/属性）批量获取一次。
    const domByNodeId = await this.describeInteractiveDom(collectInteractive(normalizedNodes, viewport));

    // 重建可交互索引：本轮快照覆盖旧索引，交互动作以最新快照为准。
    this.interactiveByIndex = new Map();
    const counter = { value: 0 };
    const budget = { value: this.maxSnapshotNodes };
    const built = roots
      .map((node) => buildNode(node, byId, domByNodeId, counter, this.interactiveByIndex, budget, viewport))
      .filter((node): node is BrowserSnapshotNode => node !== null);
    return built;
  }

  private async resolveInteractiveBounds(
    nodes: CdpAxNode[],
  ): Promise<Map<string, { x: number; y: number; width: number; height: number }>> {
    const result = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const node of nodes) {
      if (!node.nodeId) continue;
      const existing = node.boundingBox;
      if (
        existing &&
        typeof existing.x === "number" &&
        typeof existing.y === "number" &&
        typeof existing.width === "number" &&
        typeof existing.height === "number"
      ) {
        result.set(node.nodeId, {
          x: existing.x,
          y: existing.y,
          width: existing.width,
          height: existing.height,
        });
        continue;
      }
      if (node.backendDOMNodeId === undefined) continue;
      try {
        const response = (await this.sendCommand("DOM.getBoxModel", {
          backendNodeId: node.backendDOMNodeId,
        })) as { model?: { content?: number[] } };
        const bounds = boundsFromContent(response.model?.content);
        if (bounds) result.set(node.nodeId, bounds);
      } catch {
        // 元素没有布局盒或页面正在重排时不编号，避免返回不可点击的引用。
      }
    }
    return result;
  }

  private async describeInteractiveDom(nodes: CdpAxNode[]): Promise<Map<string, InteractiveDomInfo>> {
    const result = new Map<string, InteractiveDomInfo>();
    for (const node of nodes) {
      const backendId = node.backendDOMNodeId;
      if (backendId === undefined) continue;
      try {
        const dom = (await this.sendCommand("DOM.describeNode", {
          backendNodeId: backendId,
        })) as { node?: { nodeName?: string; attributes?: string[] } };
        const nodeName = (dom.node?.nodeName ?? "").toLowerCase();
        const attributes = dom.node?.attributes ?? [];
        const attrs: NonNullable<BrowserSnapshotNode["attrs"]> = {};
        for (let index = 0; index + 1 < attributes.length; index += 2) {
          const key = attributes[index];
          const value = attributes[index + 1];
          if (key === "href" && value) attrs.href = value;
          if (key === "type" && value) attrs.type = value;
          if (key === "formaction" && value) attrs.formAction = value;
          if (key === "formmethod" && value) attrs.formMethod = value;
          if (key === "name" && value) attrs.name = value;
        }
        const axProps = propsMap(node);
        const urlValue = axProps.get("url");
        if (urlValue !== undefined) attrs.href = String(urlValue);
        const checked = asBoolean(axProps.get("checked"));
        if (checked !== undefined) attrs.checked = checked;
        const selected = asBoolean(axProps.get("selected"));
        if (selected !== undefined) attrs.selected = selected;
        // 生成与标注拾取同算法的稳定选择器（供模型对照标注引用）。
        const nodeId = node.nodeId;
        if (!nodeId) continue;
        const selector = await this.resolveElementSelector(backendId);
        result.set(nodeId, { tag: nodeName, attrs, selector });
      } catch {
        // DOM 描述失败不影响树主体。
      }
    }
    return result;
  }

  /** 经 DOM.resolveNode + callFunctionOn 在页面内生成元素选择器（与 PICK_ELEMENT_SCRIPT 同算法）。 */
  private async resolveElementSelector(backendNodeId: number): Promise<string | undefined> {
    try {
      const resolved = (await this.sendCommand("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = resolved.object?.objectId;
      if (!objectId) return undefined;
      const evaluated = (await this.sendCommand("Runtime.callFunctionOn", {
        functionDeclaration: SELECTOR_FROM_ELEMENT_FN,
        objectId,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const value = evaluated.result?.value;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async evaluateViewport(): Promise<BrowserSnapshot["viewport"]> {
    const response = (await this.sendCommand("Runtime.evaluate", {
      expression: "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
      returnByValue: true,
    })) as { result?: { value?: { width?: number; height?: number; dpr?: number } } };
    const value = response.result?.value;
    return {
      width: typeof value?.width === "number" ? value.width : 0,
      height: typeof value?.height === "number" ? value.height : 0,
      dpr: typeof value?.dpr === "number" ? value.dpr : 1,
    };
  }

  private async captureCdpScreenshot(): Promise<string> {
    const response = (await this.sendCommand("Page.captureScreenshot", { format: "png" })) as {
      data?: string;
    };
    if (typeof response.data !== "string" || response.data.length === 0) {
      throw new Error("CDP 截图失败：返回空数据");
    }
    return `data:image/png;base64,${response.data}`;
  }

  private async clickElement(elementIndex: number, target?: BrowserActionTarget): Promise<void> {
    const element = await this.resolveInteractive(elementIndex, target);
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: element.center.x,
      y: element.center.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: element.center.x,
      y: element.center.y,
      button: "left",
      clickCount: 1,
    });
  }

  private async typeText(
    elementIndex: number,
    text: string,
    submit: boolean,
    replace: boolean,
    target?: BrowserActionTarget,
  ): Promise<void> {
    await this.clickElement(elementIndex, target);
    if (replace) {
      // 全选当前输入内容（select() 对 input/textarea 有效；contentEditable 用选区），
      // 随后的 insertText 会覆盖选中内容，实现替换语义（不依赖平台修饰键）。
      await this.sendCommand("Runtime.evaluate", {
        expression: `(() => {
          const el = document.activeElement;
          if (!el) return false;
          if (typeof el.select === "function") { el.select(); return true; }
          if (el.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            if (!selection) return false;
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
          }
          return false;
        })()`,
        returnByValue: true,
      });
    }
    await this.sendCommand("Input.insertText", { text });
    if (submit) {
      const enter = {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      };
      await this.sendCommand("Input.dispatchKeyEvent", enter);
      await this.sendCommand("Input.dispatchKeyEvent", { ...enter, type: "keyUp" });
    }
  }

  /** 按键（对齐 Codex CuaKeypress）：支持修饰键组合，如 "Enter"、"Control+KeyA"、"Shift+Tab"、"ControlOrMeta+Enter"。 */
  async pressKey(keySequence: string): Promise<void> {
    const parts = keySequence
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) throw new Error("key 参数非法：不能为空");
    const mainKey = parts.pop()!;
    let modifiers = 0;
    for (const part of parts) {
      const bit = CDP_MODIFIER_BITS[resolveModifier(part)];
      if (bit === undefined) throw new Error(`未知修饰键: ${part}`);
      modifiers |= bit;
    }
    const info = resolveKeyInfo(mainKey);
    // 修饰键按下顺序：先按修饰键，最后主键；松开反向。
    for (const part of parts) {
      const modifierInfo = MODIFIER_KEY_INFO[resolveModifier(part)];
      if (!modifierInfo) continue;
      await this.sendCommand("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        modifiers: CDP_MODIFIER_BITS[resolveModifier(part)],
        windowsVirtualKeyCode: modifierInfo.vkCode,
        nativeVirtualKeyCode: modifierInfo.vkCode,
        code: modifierInfo.code,
        key: modifierInfo.key,
      });
    }
    await this.sendCommand("Input.dispatchKeyEvent", {
      type: info.text ? "keyDown" : "rawKeyDown",
      modifiers,
      windowsVirtualKeyCode: info.vkCode,
      nativeVirtualKeyCode: info.vkCode,
      code: info.code,
      key: info.key,
      ...(info.text ? { text: info.text, unmodifiedText: info.text } : {}),
    });
    await this.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      windowsVirtualKeyCode: info.vkCode,
      nativeVirtualKeyCode: info.vkCode,
      code: info.code,
      key: info.key,
    });
    for (const part of [...parts].reverse()) {
      const modifierInfo = MODIFIER_KEY_INFO[resolveModifier(part)];
      if (!modifierInfo) continue;
      await this.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: CDP_MODIFIER_BITS[resolveModifier(part)],
        windowsVirtualKeyCode: modifierInfo.vkCode,
        nativeVirtualKeyCode: modifierInfo.vkCode,
        code: modifierInfo.code,
        key: modifierInfo.key,
      });
    }
  }

  private async scrollPage(direction: "up" | "down" | "top" | "bottom", amount?: number): Promise<void> {
    if (direction === "top" || direction === "bottom") {
      const expression =
        direction === "top"
          ? "window.scrollTo(0, 0)"
          : "window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))";
      await this.sendCommand("Runtime.evaluate", { expression });
      this.interactiveByIndex.clear();
      return;
    }
    const delta = (direction === "up" ? -1 : 1) * (typeof amount === "number" && amount > 0 ? amount : 400);
    await this.sendCommand("Runtime.evaluate", {
      expression: `window.scrollBy(0, ${delta})`,
    });
    this.interactiveByIndex.clear();
  }

  private async resolveInteractive(elementIndex: number, expected?: BrowserActionTarget): Promise<InteractiveElement> {
    if (expected && canonicalUrl(this.webContents.getURL()) !== canonicalUrl(expected.pageUrl)) {
      throw new StaleReferenceError();
    }
    const element = this.interactiveByIndex.get(elementIndex);
    if (!element) throw new StaleReferenceError();
    if (expected && !matchesStoredTarget(element.fingerprint, expected)) throw new StaleReferenceError();
    if (element.backendDOMNodeId === undefined) {
      if (expected) throw new StaleReferenceError();
      return element;
    }

    try {
      const response = (await this.sendCommand("DOM.getBoxModel", {
        backendNodeId: element.backendDOMNodeId,
      })) as { model?: { content?: number[] } };
      const content = response.model?.content;
      if (!content || content.length < 8 || content.some((value) => !Number.isFinite(value))) {
        throw new Error("元素 bounds 不可用");
      }
      if (expected) {
        const live = await this.readLiveTarget(element.backendDOMNodeId);
        if (!live || !matchesLiveTarget(live, expected)) throw new StaleReferenceError();
      }
      const xs = [content[0]!, content[2]!, content[4]!, content[6]!];
      const ys = [content[1]!, content[3]!, content[5]!, content[7]!];
      const next = {
        ...element,
        center: {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        },
      };
      this.interactiveByIndex.set(elementIndex, next);
      return next;
    } catch (error) {
      if (error instanceof StaleReferenceError) throw error;
      throw new StaleReferenceError();
    }
  }

  private async readLiveTarget(backendDOMNodeId: number): Promise<LiveTarget | null> {
    const resolved = (await this.sendCommand("DOM.resolveNode", { backendNodeId: backendDOMNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) return null;
    const evaluated = (await this.sendCommand("Runtime.callFunctionOn", {
      functionDeclaration: LIVE_TARGET_METADATA_FN,
      objectId,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = evaluated.result?.value;
    return isLiveTarget(value) ? value : null;
  }

  private beginAgentNavigationGuard(approvedUrl?: string): void {
    if (!this.onAgentNavigation) return;
    if (this.agentNavigationGuard) clearTimeout(this.agentNavigationGuard.timer);
    this.agentNavigationGuard = {
      ...(approvedUrl !== undefined ? { approvedUrl } : {}),
      timer: setTimeout(() => this.clearAgentNavigationGuard(), AGENT_NAVIGATION_GUARD_WINDOW_MS),
    };
  }

  private scheduleAgentNavigationGuardClear(): void {
    if (!this.agentNavigationGuard) return;
    clearTimeout(this.agentNavigationGuard.timer);
    this.agentNavigationGuard.timer = setTimeout(
      () => this.clearAgentNavigationGuard(),
      AGENT_NAVIGATION_GUARD_WINDOW_MS,
    );
  }

  private clearAgentNavigationGuard(): void {
    if (!this.agentNavigationGuard) return;
    clearTimeout(this.agentNavigationGuard.timer);
    this.agentNavigationGuard = null;
  }

  private bindWindowOpenHandler(): void {
    const setWindowOpenHandler = this.webContents.setWindowOpenHandler;
    if (typeof setWindowOpenHandler !== "function") return;
    const handler = (details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => {
      if (isHttpUrl(details.url)) this.onPopup?.(details.url);
      return { action: "deny" };
    };
    try {
      setWindowOpenHandler.call(this.webContents, handler);
      this.listeners.push(() => {
        try {
          this.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        } catch {
          // guest 已销毁时无需再替换 handler。
        }
      });
    } catch {
      // guest 在 attach/teardown 竞态中可能不接受 window-open handler。
    }
  }

  /** 懒启用 console 捕获（attach 时已统一 Runtime/Log.enable；保留幂等入口）。 */
  private async ensureConsoleCapture(): Promise<void> {
    if (this.consoleCaptureEnabled) return;
    // 懒 attach debugger：确保 Runtime/Log/Page 域已启用、事件监听已挂载，
    // 否则首次读取 console/dialog/cdpEvents 会静默返回空。
    this.ensureDebugger();
    this.consoleCaptureEnabled = true;
  }

  /** 解析 CDP console/异常事件为缓冲条目。 */
  private recordConsoleEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      const level: BrowserConsoleEntry["level"] =
        type === "error"
          ? "error"
          : type === "warning"
            ? "warning"
            : type === "debug"
              ? "debug"
              : type === "info"
                ? "info"
                : "log";
      const args = (params.args as Array<{ value?: unknown; description?: string; type?: string }> | undefined) ?? [];
      const message = args
        .map((arg) => {
          if (arg.type === "undefined") return "undefined";
          if (arg.value !== undefined) {
            try {
              return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
            } catch {
              return String(arg.value);
            }
          }
          return arg.description ?? "[object]";
        })
        .join(" ");
      const url = typeof params.url === "string" ? params.url : undefined;
      this.consoleLogBuffer.push({ level, message, timestamp: Date.now(), ...(url ? { url } : {}) });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as
        | { text?: string; url?: string; exception?: { description?: string } }
        | undefined;
      const message = details?.exception?.description ?? details?.text ?? "未捕获异常";
      this.consoleLogBuffer.push({
        level: "error",
        message,
        timestamp: Date.now(),
        ...(details?.url ? { url: details.url } : {}),
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = params.entry as { level?: string; text?: string; url?: string; timestamp?: number } | undefined;
      if (!entry?.text) return;
      const level: BrowserConsoleEntry["level"] =
        entry.level === "error"
          ? "error"
          : entry.level === "warning"
            ? "warning"
            : entry.level === "debug"
              ? "debug"
              : "log";
      this.consoleLogBuffer.push({
        level,
        message: entry.text,
        timestamp: entry.timestamp ?? Date.now(),
        ...(entry.url ? { url: entry.url } : {}),
      });
    }
  }

  /** 解析 CDP 对话框事件为挂起状态。 */
  private recordDialogEvent(method: string, params: Record<string, unknown>): void {
    if (method !== "Page.javascriptDialogOpening") return;
    const type = String(params.type ?? "alert") as BrowserPendingDialog["type"];
    this.pendingDialog = {
      type,
      message: String(params.message ?? ""),
      ...(typeof params.defaultPrompt === "string" ? { defaultText: params.defaultPrompt } : {}),
    };
  }

  private bindEvents(): void {
    const wc = this.webContents;

    const guardNavigation = (event: Electron.Event, url: string): void => {
      const guard = this.agentNavigationGuard;
      if (!guard || !this.onAgentNavigation) return;
      if (!this.onAgentNavigation(url, this.webContents.getURL(), guard.approvedUrl)) {
        // will-navigate/will-redirect 都是 URL 改变前可阻止的主 frame 导航事件。
        event.preventDefault();
        const currentUrl = this.webContents.getURL();
        const approvedHost = guard.approvedUrl ? httpUrlHost(guard.approvedUrl) : null;
        const targetHost = httpUrlHost(url);
        const currentHost = httpUrlHost(currentUrl);
        const crossSiteRedirect =
          approvedHost !== null && targetHost !== null && approvedHost !== targetHost && currentHost === approvedHost;
        this.lastNavigationBlocked = {
          url,
          reason: crossSiteRedirect ? "cross-site-redirect" : "not-approved",
        };
      }
    };
    const onWillNavigate = (event: Electron.Event, url: string): void => {
      guardNavigation(event, url);
    };
    const onWillRedirect = (event: Electron.Event, url: string): void => {
      guardNavigation(event, url);
    };
    wc.on("will-navigate", onWillNavigate);
    wc.on("will-redirect", onWillRedirect);
    this.listeners.push(() => {
      wc.off("will-navigate", onWillNavigate);
      wc.off("will-redirect", onWillRedirect);
    });

    if (this.onContextMenu) {
      const onContextMenu = (event: Electron.Event, params: Electron.ContextMenuParams): void => {
        this.onContextMenu?.(event, params);
      };
      wc.on("context-menu", onContextMenu);
      this.listeners.push(() => {
        wc.off("context-menu", onContextMenu);
      });
    }

    const onNavigated = (_event: Electron.Event, url: string): void => {
      const history = wc.navigationHistory;
      if (this.agentNavigationGuard) this.scheduleAgentNavigationGuardClear();
      this.interactiveByIndex.clear();
      this.emit({
        type: "navigated",
        url,
        canGoBack: history.canGoBack(),
        canGoForward: history.canGoForward(),
      });
    };
    wc.on("did-navigate", onNavigated);
    this.listeners.push(() => {
      wc.off("did-navigate", onNavigated);
    });

    const onNavigatedInPage = (_event: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame) return;
      if (this.agentNavigationGuard) this.scheduleAgentNavigationGuardClear();
      this.interactiveByIndex.clear();
      this.emit({ type: "navigated-in-page", url });
    };
    wc.on("did-navigate-in-page", onNavigatedInPage);
    this.listeners.push(() => {
      wc.off("did-navigate-in-page", onNavigatedInPage);
    });

    const onTitleUpdated = (_event: Electron.Event, title: string): void => {
      this.emit({ type: "title-updated", title });
    };
    wc.on("page-title-updated", onTitleUpdated);
    this.listeners.push(() => {
      wc.off("page-title-updated", onTitleUpdated);
    });

    const onStartLoading = (): void => {
      this.interactiveByIndex.clear();
      this.emit({ type: "loading-changed", loading: true });
    };
    wc.on("did-start-loading", onStartLoading);
    this.listeners.push(() => {
      wc.off("did-start-loading", onStartLoading);
    });

    const onStopLoading = (): void => {
      this.emit({ type: "loading-changed", loading: false });
    };
    wc.on("did-stop-loading", onStopLoading);
    this.listeners.push(() => {
      wc.off("did-stop-loading", onStopLoading);
    });

    // 加载失败（DNS/连接/证书等网络错误）：-3 (ERR_ABORTED) 是用户停止或
    // 被新导航取代，不算失败；其余错误上报给 UI 展示。
    const onDidFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return;
      this.clearAgentNavigationGuard();
      if (errorCode === -3) return;
      this.emit({
        type: "load-failed",
        url: validatedURL,
        code: errorCode,
        description: errorDescription,
      });
    };
    wc.on("did-fail-load", onDidFailLoad);
    this.listeners.push(() => {
      wc.off("did-fail-load", onDidFailLoad);
    });

    const onRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      this.emit({ type: "crashed", reason: details.reason });
    };
    wc.on("render-process-gone", onRenderProcessGone);
    this.listeners.push(() => {
      wc.off("render-process-gone", onRenderProcessGone);
    });

    const onDestroyed = (): void => {
      this.emit({ type: "destroyed" });
    };
    wc.on("destroyed", onDestroyed);
    this.listeners.push(() => {
      wc.off("destroyed", onDestroyed);
    });
  }

  private emit(event: BrowserHostEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }
}

/** 收集可交互且可见的节点（供 DOM 描述与编号）。viewport 提供时，中心点不在
 *  视口内的元素视为不可见（离屏元素点击坐标不可达）。 */
export function collectInteractive(nodes: CdpAxNode[], viewport?: { width: number; height: number }): CdpAxNode[] {
  const interactive: CdpAxNode[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value ?? "";
    if (INTERACTIVE_ROLES.has(role) && (isVisible(node, viewport) || node.backendDOMNodeId !== undefined))
      interactive.push(node);
  }
  return interactive;
}

function boundsFromContent(
  content: number[] | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!content || content.length < 8 || content.some((value) => !Number.isFinite(value))) return null;
  const xs = [content[0]!, content[2]!, content[4]!, content[6]!];
  const ys = [content[1]!, content[3]!, content[5]!, content[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function isVisible(node: CdpAxNode, viewport?: { width: number; height: number }): boolean {
  const box = node.boundingBox;
  if (!box || box.width === undefined || box.height === undefined || box.width <= 0 || box.height <= 0) {
    return false;
  }
  // 无视口信息（单测/评估失败）时退化为仅尺寸检查。
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return true;
  const centerX = box.x !== undefined ? box.x + box.width / 2 : NaN;
  const centerY = box.y !== undefined ? box.y + box.height / 2 : NaN;
  return centerX >= 0 && centerX <= viewport.width && centerY >= 0 && centerY <= viewport.height;
}

/** 纯函数（导出供测试）：构建简化树。budget 为剩余节点配额（0 时停止输出）。
 *  viewport 提供时过滤中心点不在视口内的元素。 */
export function buildNode(
  node: CdpAxNode,
  byId: Map<string, CdpAxNode>,
  domByNodeId: Map<string, InteractiveDomInfo>,
  counter: { value: number },
  interactiveByIndex: Map<number, InteractiveElement>,
  budget: { value: number },
  viewport?: { width: number; height: number },
): BrowserSnapshotNode | null {
  if (node.ignored) {
    // ignored 节点自身不输出，但继续输出其子节点。
    return collapseChildren(node, byId, domByNodeId, counter, interactiveByIndex, budget, viewport);
  }
  if (budget.value <= 0) return null;
  budget.value -= 1;
  const role = node.role?.value ?? "generic";
  const interactive = INTERACTIVE_ROLES.has(role) && isVisible(node, viewport);
  const dom = node.nodeId ? domByNodeId.get(node.nodeId) : undefined;
  const nodeId = node.nodeId;
  const built: BrowserSnapshotNode = {
    role,
    name: truncate(node.name?.value ?? "", NAME_MAX_CHARS),
    tag: dom?.tag ?? roleToTag(role),
  };
  const rawValue = node.value?.value;
  if (typeof rawValue === "string" && rawValue.length > 0) {
    built.value = truncate(rawValue, NAME_MAX_CHARS);
  }
  const attrs = dom?.attrs;
  if (attrs && Object.keys(attrs).length > 0) built.attrs = attrs;
  if (interactive && dom?.selector) built.selector = dom.selector;
  const box = node.boundingBox;
  if (
    interactive &&
    box &&
    box.x !== undefined &&
    box.y !== undefined &&
    box.width !== undefined &&
    box.height !== undefined
  ) {
    const center = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
    counter.value += 1;
    built.index = counter.value;
    built.center = center;
    if (nodeId) {
      const interactiveElement: InteractiveElement = { index: counter.value, center };
      if (node.backendDOMNodeId !== undefined) {
        interactiveElement.backendDOMNodeId = node.backendDOMNodeId;
        interactiveElement.snapshotNode = built;
        interactiveElement.fingerprint = {
          role: built.role,
          tag: built.tag,
          name: built.name,
          ...(built.selector !== undefined ? { selector: built.selector } : {}),
          ...(built.attrs !== undefined ? { attrs: { ...built.attrs } } : {}),
        };
      }
      interactiveByIndex.set(counter.value, interactiveElement);
    }
  }
  const children = (node.childIds ?? [])
    .map((childId) => {
      const child = byId.get(childId);
      return child ? buildNode(child, byId, domByNodeId, counter, interactiveByIndex, budget, viewport) : null;
    })
    .filter((child): child is BrowserSnapshotNode => child !== null);
  if (children.length > 0) built.children = children;
  return built;
}

/** ignored 节点的子节点直接上提（不引入中间层）。 */
export function collapseChildren(
  node: CdpAxNode,
  byId: Map<string, CdpAxNode>,
  domByNodeId: Map<string, InteractiveDomInfo>,
  counter: { value: number },
  interactiveByIndex: Map<number, InteractiveElement>,
  budget: { value: number },
  viewport?: { width: number; height: number },
): BrowserSnapshotNode | null {
  const children = (node.childIds ?? [])
    .map((childId) => {
      const child = byId.get(childId);
      return child ? buildNode(child, byId, domByNodeId, counter, interactiveByIndex, budget, viewport) : null;
    })
    .filter((child): child is BrowserSnapshotNode => child !== null);
  if (children.length === 0) return null;
  // 多个子节点时合并为 generic 容器；单子节点直接提升。
  if (children.length === 1) return children[0];
  return { role: "generic", name: "", tag: "generic", children };
}

function propsMap(node: CdpAxNode): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const property of node.properties ?? []) {
    if (property.name && property.value?.value !== undefined) {
      map.set(property.name, property.value.value);
    }
  }
  return map;
}

/** CDP 属性值转布尔：boolean 直取；"true"/"false" 字符串解析；其余（含 "mixed"）视为未定义。 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const roleToTagMap: Record<string, string> = {
  button: "button",
  link: "a",
  textbox: "input",
  combobox: "select",
  checkbox: "input",
  radio: "input",
  menuitem: "li",
  switch: "button",
};

function roleToTag(role: string): string {
  return roleToTagMap[role] ?? role;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`CDP 命令超时（${timeoutMs}ms）`));
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/** 解析 http/https URL 的 host；非 http(s) 或非法 URL 返回 null。 */
function httpUrlHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * 构造元素查找 JS 表达式：返回文档/iframe 文档根与匹配节点数组。
 * 对齐 Codex PlaywrightLocator 的语义定位：by 支持 css/role/text/label/placeholder/testid；
 * frame 为 iframe 的 CSS 选择器（同源 contentDocument 内查找）。
 */
function buildElementQueryParts(
  selector: string,
  options: {
    by?: "css" | "role" | "text" | "label" | "placeholder" | "testid";
    byValue?: string;
    name?: string;
    frame?: string;
  } = {},
): { root: string; nodes: string; prelude: string } {
  const by = options.by ?? "css";
  const byValue = options.byValue ?? selector;
  const nameFilter = options.name;
  const root = options.frame
    ? `(() => { const f = document.querySelector(${JSON.stringify(options.frame)}); if (!f || !f.contentDocument) return null; return f.contentDocument; })()`
    : "document";
  let nodes: string;
  switch (by) {
    case "role": {
      // 显式 role 或隐式 ARIA role（按钮/链接/输入等），可选 name 过滤（对齐 Playwright getByRole name）。
      const nameCond = nameFilter === undefined ? "" : ` && (accessibleNameOf(el) === ${JSON.stringify(nameFilter)})`;
      nodes = `[...${root}.querySelectorAll('*')].filter((el) => {
        const explicit = el.getAttribute && el.getAttribute('role');
        const implicit = el.tagName ? implicitRoleOf(el) : '';
        if (explicit !== ${JSON.stringify(byValue)} && implicit !== ${JSON.stringify(byValue)}) return false;${nameCond}
        return true;
      })`;
      break;
    }
    case "label": {
      // aria-label、label[for] 关联、包裹 label 文本（对齐 Playwright getByLabel）。
      const nameCond =
        nameFilter === undefined
          ? ` && ((el.getAttribute && el.getAttribute('aria-label')) || accessibleNameOf(el)).includes(${JSON.stringify(byValue)})`
          : ` && (accessibleNameOf(el) === ${JSON.stringify(nameFilter)})`;
      nodes = `[...${root}.querySelectorAll('*')].filter((el) => {
        if (!el.tagName) return false;
        if (el.getAttribute && el.getAttribute('aria-label')) return ${JSON.stringify(byValue)} === el.getAttribute('aria-label');
        if (el.id) { const l = ${root}.querySelector('label[for="' + el.id + '"]'); if (l && (l.textContent || '').includes(${JSON.stringify(byValue)})) return true; }
        if (el.closest && el.closest('label') && (el.closest('label').textContent || '').includes(${JSON.stringify(byValue)})) return true;${nameCond}
        return false;
      })`;
      break;
    }
    case "placeholder":
      nodes = `${root}.querySelectorAll(${JSON.stringify(`[placeholder="${byValue}"]`)})`;
      break;
    case "testid":
      nodes = `${root}.querySelectorAll(${JSON.stringify(`[data-testid="${byValue}"]`)})`;
      break;
    case "text":
      nodes = `[...${root}.querySelectorAll('body *')].filter((e) => e.children.length === 0 && (e.textContent || '').includes(${JSON.stringify(byValue)}))`;
      break;
    default:
      nodes = `${root}.querySelectorAll(${JSON.stringify(selector)})`;
      break;
  }
  const prelude = by === "role" || by === "label" ? IMPLICIT_ROLE_HELPER : "";
  return { root, nodes, prelude };
}

/** 隐式 ARIA role 映射（对齐 Playwright getByRole 的隐式 role 语义）。 */
const IMPLICIT_ROLE_HELPER = `const implicitRoleOf = (el) => {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.href) return 'link';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button' || t === 'image') return 'button';
    if (t === 'search') return 'searchbox';
    return 'textbox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
  if (tag === 'img') return 'img';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (tag === 'table') return 'table';
  if (tag === 'form') return 'form';
  if (tag === 'nav') return 'navigation';
  if (tag === 'header') return 'banner';
  if (tag === 'footer') return 'contentinfo';
  if (tag === 'main') return 'main';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'progress') return 'progressbar';
  return '';
};
const accessibleNameOf = (el) => {
  if (el.getAttribute && el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledby) { const ref = document.getElementById(labelledby); if (ref) return (ref.textContent || '').trim(); }
  return (el.textContent || '').trim();
};
`;

/** 构造“第 nth 个匹配元素或 null”的表达式。 */
function buildElementQuery(
  selector: string,
  options: {
    by?: "css" | "role" | "text" | "label" | "placeholder" | "testid";
    byValue?: string;
    name?: string;
    frame?: string;
    nth?: number;
  } = {},
): string {
  const { root, nodes, prelude } = buildElementQueryParts(selector, options);
  const nth = typeof options.nth === "number" && options.nth > 0 ? options.nth : 0;
  return `(() => { ${prelude}const root = ${root}; if (!root) return null; const all = ${nodes}; return all.length > ${nth} ? all[${nth}] : null; })()`;
}

/** 构造“匹配数量”的表达式（count 场景）。 */
function buildElementCountQuery(
  selector: string,
  options: {
    by?: "css" | "role" | "text" | "label" | "placeholder" | "testid";
    byValue?: string;
    name?: string;
    frame?: string;
  } = {},
): string {
  const { root, nodes, prelude } = buildElementQueryParts(selector, options);
  return `(() => { ${prelude}const root = ${root}; if (!root) return 0; return ${nodes}.length; })()`;
}

/** 从 base64 PNG 解析像素尺寸（读 IHDR 头；失败返回 0）。 */
function pngDimensions(base64: string): { width: number; height: number } {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** CDP Input 修饰键位掩码（对齐 Codex CUA 的 Nn）。 */
const CDP_MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  control: 2,
  meta: 4,
  shift: 8,
};

/** 不缓冲的高频 CDP 事件（避免 readCdpEvents 被渲染噪音淹没）。 */
const IGNORED_CDP_EVENTS = new Set([
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
  "Page.javascriptDialogOpening",
  "Page.frameScheduledNavigation",
  "Page.frameClearedScheduledNavigation",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Network.dataReceived",
]);

/** 修饰键自身的键信息（按下修饰键时需要单独派发）。 */
const MODIFIER_KEY_INFO: Record<string, { key: string; code: string; vkCode: number }> = {
  alt: { key: "Alt", code: "AltLeft", vkCode: 18 },
  control: { key: "Control", code: "ControlLeft", vkCode: 17 },
  meta: { key: "Meta", code: "MetaLeft", vkCode: 91 },
  shift: { key: "Shift", code: "ShiftLeft", vkCode: 16 },
};

/** 常用非字符键表（照搬 Codex browser-client 的键映射子集）。 */
const NAMED_KEYS: Record<string, { key: string; code: string; vkCode: number; text?: string }> = {
  Escape: { key: "Escape", code: "Escape", vkCode: 27 },
  Enter: { key: "Enter", code: "Enter", vkCode: 13, text: "\r" },
  Return: { key: "Enter", code: "Enter", vkCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vkCode: 9 },
  Space: { key: " ", code: "Space", vkCode: 32, text: " " },
  Backspace: { key: "Backspace", code: "Backspace", vkCode: 8 },
  Delete: { key: "Delete", code: "Delete", vkCode: 46 },
  Del: { key: "Delete", code: "Delete", vkCode: 46 },
  Home: { key: "Home", code: "Home", vkCode: 36 },
  End: { key: "End", code: "End", vkCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vkCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vkCode: 34 },
  Insert: { key: "Insert", code: "Insert", vkCode: 45 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vkCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vkCode: 39 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vkCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vkCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", vkCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", vkCode: 39 },
  Up: { key: "ArrowUp", code: "ArrowUp", vkCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", vkCode: 40 },
  F1: { key: "F1", code: "F1", vkCode: 112 },
  F2: { key: "F2", code: "F2", vkCode: 113 },
  F3: { key: "F3", code: "F3", vkCode: 114 },
  F4: { key: "F4", code: "F4", vkCode: 115 },
  F5: { key: "F5", code: "F5", vkCode: 116 },
  F6: { key: "F6", code: "F6", vkCode: 117 },
  F7: { key: "F7", code: "F7", vkCode: 118 },
  F8: { key: "F8", code: "F8", vkCode: 119 },
  F9: { key: "F9", code: "F9", vkCode: 120 },
  F10: { key: "F10", code: "F10", vkCode: 121 },
  F11: { key: "F11", code: "F11", vkCode: 122 },
  F12: { key: "F12", code: "F12", vkCode: 123 },
};

/** 修饰键别名归一（照搬 Codex 的 jm/别名表）。 */
function normalizeModifier(raw: string): string {
  const lower = raw.toLowerCase();
  switch (lower) {
    case "cmd":
    case "command":
    case "win":
    case "super":
      return "meta";
    case "ctrl":
      return "control";
    case "option":
      return "alt";
    default:
      return lower;
  }
}

/** ControlOrMeta 按平台解析（darwin → Meta，其余 → Control；照搬 Codex 的 jm）。 */
function resolveModifier(raw: string): string {
  const normalized = normalizeModifier(raw);
  if (normalized === "controlormeta") return process.platform === "darwin" ? "meta" : "control";
  return normalized;
}

/** 解析按键名：命名字典 → 单字符 → 数字/字母键。 */
function resolveKeyInfo(raw: string): { key: string; code: string; vkCode: number; text?: string } {
  const named = NAMED_KEYS[raw];
  if (named) return named;
  if (raw.length === 1) {
    const code = /[a-zA-Z]/.test(raw) ? `Key${raw.toUpperCase()}` : `Digit${raw}`;
    const upper = raw.toUpperCase();
    const vkCode = /[a-zA-Z]/.test(raw) ? upper.charCodeAt(0) : raw.charCodeAt(0);
    return { key: raw, code, vkCode, text: raw };
  }
  // 支持 Codex 风格键名（KeyA 等）与数字键。
  const codeMatch = /^Key([A-Za-z])$/.exec(raw);
  if (codeMatch) {
    const letter = codeMatch[1]!;
    return { key: letter, code: raw, vkCode: letter.toUpperCase().charCodeAt(0), text: letter };
  }
  throw new Error(`未知按键: ${raw}`);
}

function matchesStoredTarget(
  fingerprint: Omit<BrowserActionTarget, "pageUrl"> | undefined,
  expected: BrowserActionTarget,
): boolean {
  if (!fingerprint) return false;
  return (
    fingerprint.role === expected.role &&
    fingerprint.tag === expected.tag &&
    fingerprint.name === expected.name &&
    (fingerprint.selector ?? "") === (expected.selector ?? "") &&
    matchesAttrs(fingerprint.attrs, expected.attrs)
  );
}

function matchesLiveTarget(live: LiveTarget, expected: BrowserActionTarget): boolean {
  return (
    live.tag === expected.tag &&
    (live.name.length === 0 || expected.name.length === 0 || live.name === expected.name) &&
    (live.selector ?? "") === (expected.selector ?? "") &&
    matchesAttrs(live.attrs, expected.attrs)
  );
}

function matchesAttrs(
  actual: BrowserSnapshotNode["attrs"] | undefined,
  expected: BrowserSnapshotNode["attrs"] | undefined,
): boolean {
  if (!expected) return true;
  const keys = ["href", "type", "checked", "selected", "formAction", "formMethod", "name"] as const;
  for (const key of keys) {
    if (expected[key] !== undefined && actual?.[key] !== expected[key]) return false;
  }
  return true;
}

function isLiveTarget(value: unknown): value is LiveTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tag === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.selector === "string" &&
    (candidate.attrs === undefined || typeof candidate.attrs === "object")
  );
}

/** 页面内执行的元素选择器生成函数（callFunctionOn：this 为 DOM 元素）。
 *  与 PICK_ELEMENT_SCRIPT 的选择器生成规则一致（id 优先 → tag+class → nth-child，至多 5 层）。 */
const SELECTOR_FROM_ELEMENT_FN = `function () {
  const el = this;
  if (!el || el.nodeType !== 1) return "";
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length > 0) {
      part += "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
      if (sameTag.length > 1) {
        part += ":nth-child(" + (Array.from(parent.children).indexOf(node) + 1) + ")";
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}`;

/** 页面内读取元素指纹；执行动作前用于检测确认后的 DOM 替换或属性篡改。 */
const LIVE_TARGET_METADATA_FN = `function () {
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const attrs = {};
  if (typeof el.href === "string" && el.href.length > 0) attrs.href = el.href;
  for (const name of ["type", "formaction", "formmethod", "name"]) {
    const value = el.getAttribute(name);
    if (value) attrs[name === "formaction" ? "formAction" : name === "formmethod" ? "formMethod" : name] = value;
  }
  if (typeof el.checked === "boolean") attrs.checked = el.checked;
  if (typeof el.selected === "boolean") attrs.selected = el.selected;
  const labelledBy = el.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ? labelledBy
        .split(/s+/u)
        .map((id) => document.getElementById(id)?.innerText ?? "")
        .join(" ")
        .trim()
    : "";
  const labelText = el.labels?.[0]?.innerText?.trim() ?? "";
  const rawName = (
    el.getAttribute("aria-label") ||
    labelledText ||
    labelText ||
    el.innerText ||
    el.value ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.getAttribute("name") ||
    ""
  ).trim();
  const name = rawName.length > 120 ? rawName.slice(0, 120) + "…" : rawName;
  return {
    tag: el.tagName.toLowerCase(),
    name,
    selector: (${SELECTOR_FROM_ELEMENT_FN}).call(el),
    attrs,
  };
}`;

/** 页面内执行的元素选取脚本：elementFromPoint + 稳定选择器生成（标注模式）。
 *  选取策略：空白区域（body/html）不可标注；优先提升到最近的可交互祖先
 *  （button/a/input 等，最多 4 层），hover 控件内部文本时高亮整个控件；
 *  提升结果超过视口 70% 时回退到原始元素（避免高亮超大容器）。
 *  生成规则：优先 id；其次 tag + 有限 class；同 tag 兄弟多时追加 nth-child；
 *  至多向上 5 层；返回选择器与视口 bounds。 */
const PICK_ELEMENT_SCRIPT = `(() => {
  const INTERACTIVE = "button, a, input, textarea, select, label, summary, [role=button], [role=link], [role=textbox], [role=checkbox], [role=radio], [role=combobox], [role=menuitem], [role=switch], [tabindex], audio, video, iframe";
  const raw = document.elementFromPoint(__X__, __Y__);
  if (!raw || raw.nodeType !== 1) return { error: "点击位置没有可标注的元素" };
  const tag = raw.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return { error: "空白区域，没有可标注的元素" };
  let candidate = raw;
  for (let depth = 0; depth < 4; depth++) {
    if (candidate.matches(INTERACTIVE)) break;
    const parent = candidate.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    candidate = parent;
  }
  const probe = candidate.getBoundingClientRect();
  if (probe.width > innerWidth * 0.7 || probe.height > innerHeight * 0.7) candidate = raw;
  const el = candidate;
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
    let part = node.tagName.toLowerCase();
    if (node.classList && node.classList.length > 0) {
      part += "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
      if (sameTag.length > 1) {
        part += ":nth-child(" + (Array.from(parent.children).indexOf(node) + 1) + ")";
      }
    }
    parts.unshift(part);
    node = parent;
  }
  const r = el.getBoundingClientRect();
  return {
    selector: parts.join(" > "),
    bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    tag: el.tagName.toLowerCase(),
    name: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 120),
  };
})()`;
