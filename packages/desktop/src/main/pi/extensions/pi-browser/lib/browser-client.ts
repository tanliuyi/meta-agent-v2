/**
 * pi-browser 扩展的浏览器宿主客户端。
 *
 * pi extension 运行在 Electron-as-Node sidecar 进程，无法直接引用 main 进程的
 * BrowserManager；main 在 127.0.0.1 随机端口起本地 HTTP RPC（browser-host-server），
 * endpoint 与 token 经 worker 环境变量 PI_BROWSER_HOST_PORT / PI_BROWSER_TOKEN
 * 注入，会话身份经 PI_BROWSER_SESSION_PROJECT_ID / PI_BROWSER_SESSION_THREAD_ID
 * 注入（由 ThreadWorkerBinding 派生）。本客户端封装 fetch 调用与 Result 解析；
 * 身份缺失时构造即失败（fail-closed），每个请求都携带身份头。
 */

import type {
  BrowserAction,
  BrowserActionResult,
  BrowserConsoleEntry,
  BrowserEvaluateResult,
  BrowserHistoryEntry,
  BrowserInspectElementResult,
  BrowserNavigateResult,
  BrowserNavigationTargetResult,
  BrowserOpenTabResult,
  BrowserPendingDialog,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserTab,
} from "../../../../../shared/browser-contracts.ts";
import type { BrowserSettingsSnapshot } from "../../../../../shared/browser-settings-contracts.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 130_000;
const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  navigate: 35_000,
  tabsList: 15_000,
  activeTab: 15_000,
  history: 15_000,
  historyTarget: 15_000,
  getSettings: 15_000,
  clearData: 30_000,
};

/** 浏览器宿主服务不可达/未就绪（env 缺失、连接失败、HTTP 错误）。 */
export class BrowserUnavailableError extends Error {}

export interface BrowserClientOptions {
  /** 覆盖 PI_BROWSER_HOST_PORT（测试注入）。 */
  port?: number;
  /** 覆盖 PI_BROWSER_TOKEN（测试注入）。 */
  token?: string;
  /** 覆盖 PI_BROWSER_SESSION_TOKEN（每个 worker 独有的 capability）。 */
  sessionToken?: string;
  /** 覆盖 PI_BROWSER_SESSION_PROJECT_ID（测试注入）。 */
  sessionProjectId?: string;
  /** 覆盖 PI_BROWSER_SESSION_THREAD_ID（测试注入）。 */
  sessionThreadId?: string;
  /** 覆盖全局 fetch（测试注入）。 */
  fetchImpl?: typeof fetch;
}

/** 与 main 进程 BrowserManager 的 RPC 客户端（会话身份随每个请求发送）。 */
export class BrowserClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly sessionToken: string;
  private readonly sessionProjectId: string;
  private readonly sessionThreadId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BrowserClientOptions = {}) {
    const port = options.port ?? envPort();
    const token = options.token ?? envToken();
    const sessionToken = options.sessionToken ?? envSessionToken();
    const sessionProjectId = options.sessionProjectId ?? envSessionProjectId();
    const sessionThreadId = options.sessionThreadId ?? envSessionThreadId();
    if (port === undefined || token === undefined) {
      throw new BrowserUnavailableError("浏览器宿主服务未就绪（缺少 PI_BROWSER_HOST_PORT/PI_BROWSER_TOKEN）");
    }
    if (sessionToken === undefined) {
      throw new BrowserUnavailableError("浏览器宿主服务未就绪（缺少 PI_BROWSER_SESSION_TOKEN）");
    }
    if (!sessionProjectId || !sessionThreadId) {
      throw new BrowserUnavailableError(
        "浏览器宿主服务未就绪（缺少 PI_BROWSER_SESSION_PROJECT_ID/PI_BROWSER_SESSION_THREAD_ID）",
      );
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
    this.sessionToken = sessionToken;
    this.sessionProjectId = sessionProjectId;
    this.sessionThreadId = sessionThreadId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async tabsList(signal?: AbortSignal): Promise<BrowserTab[]> {
    return (await this.request("tabsList", undefined, signal)) as BrowserTab[];
  }

  async activeTab(signal?: AbortSignal): Promise<BrowserTab | null> {
    return (await this.request("activeTab", undefined, signal)) as BrowserTab | null;
  }

  async navigate(tabId: number, url: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    return (await this.request("navigate", { tabId, url }, signal)) as BrowserNavigateResult;
  }

  async historyTarget(
    tabId: number,
    direction: "back" | "forward",
    signal?: AbortSignal,
  ): Promise<BrowserNavigationTargetResult> {
    return (await this.request("historyTarget", { tabId, direction }, signal)) as BrowserNavigationTargetResult;
  }

  async goBack(tabId: number, navigationApprovalUrl?: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    return (await this.request("goBack", { tabId, navigationApprovalUrl }, signal)) as BrowserNavigateResult;
  }

  async goForward(tabId: number, navigationApprovalUrl?: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    return (await this.request("goForward", { tabId, navigationApprovalUrl }, signal)) as BrowserNavigateResult;
  }

  async reload(tabId: number, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    return (await this.request("reload", { tabId }, signal)) as BrowserNavigateResult;
  }

  async snapshot(
    tabId: number,
    opts: { withScreenshot?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<BrowserSnapshotResult> {
    return (await this.request(
      "snapshot",
      {
        tabId,
        withScreenshot: opts.withScreenshot === true,
      },
      signal,
    )) as BrowserSnapshotResult;
  }

  async inspectElement(
    tabId: number,
    elementIndex: number,
    signal?: AbortSignal,
  ): Promise<BrowserInspectElementResult> {
    return (await this.request("inspectElement", { tabId, elementIndex }, signal)) as BrowserInspectElementResult;
  }

  async action(tabId: number, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    return (await this.request("action", { tabId, action }, signal)) as BrowserActionResult;
  }

  async openTab(url: string, signal?: AbortSignal): Promise<BrowserOpenTabResult> {
    return (await this.request("openTab", { url }, signal)) as BrowserOpenTabResult;
  }

  async screenshot(tabId: number, signal?: AbortSignal): Promise<BrowserScreenshotResult> {
    return (await this.request("screenshot", { tabId }, signal)) as BrowserScreenshotResult;
  }

  /** 全页截图（完整滚动区域）。 */
  async fullPageScreenshot(tabId: number, signal?: AbortSignal): Promise<BrowserScreenshotResult> {
    return (await this.request("screenshot", { tabId, fullPage: true }, signal)) as BrowserScreenshotResult;
  }

  /** 读取页面 console 日志（拉取即清空）。 */
  async consoleLogs(
    tabId: number,
    options: { filter?: string; levels?: BrowserConsoleEntry["level"][]; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ ok: true; logs: BrowserConsoleEntry[] } | { ok: false; error: string }> {
    return (await this.request("consoleLogs", { tabId, ...options }, signal)) as
      | {
          ok: true;
          logs: BrowserConsoleEntry[];
        }
      | { ok: false; error: string };
  }

  /** 当前挂起的 JS 对话框。 */
  async getDialog(
    tabId: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true; dialog: BrowserPendingDialog | null } | { ok: false; error: string }> {
    return (await this.request("getDialog", { tabId }, signal)) as
      | {
          ok: true;
          dialog: BrowserPendingDialog | null;
        }
      | { ok: false; error: string };
  }

  /** 响应挂起的 JS 对话框。 */
  async handleDialog(
    tabId: number,
    action: "accept" | "dismiss",
    promptText?: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request(
      "handleDialog",
      { tabId, action, ...(promptText !== undefined ? { promptText } : {}) },
      signal,
    )) as { ok: true } | { ok: false; error: string };
  }

  /** 在页面上下文执行 JS。 */
  async evaluate(
    tabId: number,
    expression: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; result: BrowserEvaluateResult } | { ok: false; error: string }> {
    return (await this.request("evaluate", { tabId, expression }, signal)) as
      | {
          ok: true;
          result: BrowserEvaluateResult;
        }
      | { ok: false; error: string };
  }

  /** 关闭指定标签页（renderer 删除视图并 detach）。 */
  async closeTab(tabId: number, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("closeTab", { tabId }, signal)) as { ok: true } | { ok: false; error: string };
  }

  /** 按键（组合键如 "Control+Enter"）。 */
  async pressKey(
    tabId: number,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("pressKey", { tabId, key }, signal)) as { ok: true } | { ok: false; error: string };
  }

  /** 等待页面条件（load/timeout/url）。 */
  async waitFor(
    tabId: number,
    options: { state?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number; url?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("waitFor", { tabId, ...options }, signal)) as
      | { ok: true }
      | { ok: false; error: string };
  }

  /** 读取缓冲的 CDP 事件（拉取即清空）。 */
  async cdpEvents(
    tabId: number,
    options: { methods?: string[]; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<
    { ok: true; events: Array<{ method: string; params?: Record<string, unknown> }> } | { ok: false; error: string }
  > {
    return (await this.request("cdpEvents", { tabId, ...options }, signal)) as
      | {
          ok: true;
          events: Array<{ method: string; params?: Record<string, unknown> }>;
        }
      | { ok: false; error: string };
  }

  /** 读剪贴板文本。 */
  async clipboardRead(
    tabId: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    return (await this.request("clipboardRead", { tabId }, signal)) as
      | { ok: true; text: string }
      | { ok: false; error: string };
  }

  /** 写剪贴板文本。 */
  async clipboardWrite(
    tabId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("clipboardWrite", { tabId, text }, signal)) as
      | { ok: true }
      | { ok: false; error: string };
  }

  /** 按选择器执行元素操作（对齐 Codex PlaywrightLocator）。 */
  async locatorAction(
    tabId: number,
    selector: string,
    action: string,
    params: {
      value?: string;
      attribute?: string;
      name?: string;
      by?: "css" | "role" | "text" | "label" | "placeholder" | "testid";
      byValue?: string;
      frame?: string;
      nth?: number;
    } = {},
    signal?: AbortSignal,
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
    return (await this.request("locatorAction", { tabId, selector, action, ...params }, signal)) as
      | {
          ok: true;
          value?: string;
          count?: number;
          visible?: boolean;
          enabled?: boolean;
          info?: Record<string, unknown>;
          screenshot?: { dataUrl: string; width: number; height: number };
        }
      | { ok: false; error: string };
  }

  /** 原始 CDP 命令（对齐 Codex cdp.send）。 */
  async cdpSend(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    return (await this.request("cdpSend", { tabId, method, ...(params ? { params } : {}) }, signal)) as
      | {
          ok: true;
          result: unknown;
        }
      | { ok: false; error: string };
  }

  /** 等待下一次导航完成（对齐 Codex expectNavigation）。 */
  async expectNavigation(
    tabId: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request(
      "expectNavigation",
      { tabId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      signal,
    )) as { ok: true } | { ok: false; error: string };
  }

  /** 拖拽：沿坐标路径移动鼠标（对齐 Codex CUA drag）。 */
  async dragPath(
    tabId: number,
    points: Array<{ x: number; y: number }>,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("dragPath", { tabId, points }, signal)) as { ok: true } | { ok: false; error: string };
  }

  /** 移动鼠标到坐标（对齐 Codex CUA move）。 */
  async moveMouse(
    tabId: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("moveMouse", { tabId, x, y }, signal)) as { ok: true } | { ok: false; error: string };
  }

  /** 坐标双击（对齐 Codex CUA double_click）。 */
  async dblclickPoint(
    tabId: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("dblclickPoint", { tabId, x, y }, signal)) as
      | { ok: true }
      | { ok: false; error: string };
  }

  /** 导出页面主文本（对齐 Codex ContentAPI.export）。 */
  async contentExport(
    tabId: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    return (await this.request("contentExport", { tabId }, signal)) as
      | { ok: true; text: string }
      | { ok: false; error: string };
  }

  /** 最近下载记录。 */
  async downloads(
    tabId: number,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; downloads: Array<{ url: string; filename: string; path: string | null }> }
    | { ok: false; error: string }
  > {
    return (await this.request("downloads", { tabId }, signal)) as
      | {
          ok: true;
          downloads: Array<{ url: string; filename: string; path: string | null }>;
        }
      | { ok: false; error: string };
  }

  /** 文件上传。 */
  async uploadFile(
    tabId: number,
    selector: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("uploadFile", { tabId, selector, path }, signal)) as
      | { ok: true }
      | { ok: false; error: string };
  }

  /** 触发下载并保存到指定路径。 */
  async downloadMedia(
    tabId: number,
    url: string,
    savePath: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("downloadMedia", { tabId, url, savePath }, signal)) as
      | {
          ok: true;
        }
      | { ok: false; error: string };
  }

  /** 坐标点击（对齐 Codex CUA clickPoint）。 */
  async clickPoint(
    tabId: number,
    x: number,
    y: number,
    keys?: string[],
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return (await this.request("clickPoint", { tabId, x, y, ...(keys ? { keys } : {}) }, signal)) as
      | {
          ok: true;
        }
      | { ok: false; error: string };
  }

  async browserHistory(signal?: AbortSignal): Promise<BrowserHistoryEntry[]> {
    return (await this.request("history", undefined, signal)) as BrowserHistoryEntry[];
  }

  async getSettings(signal?: AbortSignal): Promise<BrowserSettingsSnapshot> {
    return (await this.request("getSettings", undefined, signal)) as BrowserSettingsSnapshot;
  }

  /** 发送 RPC 请求并返回 manager 方法的结果（Result 或裸值）；网络/HTTP/信封错误统一抛错。 */
  private async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-desktop-browser-token": this.token,
          "x-desktop-browser-session-token": this.sessionToken,
          "x-desktop-browser-session-project-id": this.sessionProjectId,
          "x-desktop-browser-session-thread-id": this.sessionThreadId,
        },
        body: JSON.stringify({ method, params }),
        signal: combineSignals(signal, REQUEST_TIMEOUTS_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BrowserUnavailableError(`浏览器宿主服务不可达：${messageOf(error)}`);
    }
    if (!response.ok) {
      // 透传服务端错误文案（如 openTab 超时），避免模型只看到 HTTP 状态码。
      let serverError: unknown;
      try {
        serverError = (await response.json()) as unknown;
      } catch {
        // 非 JSON 响应体：回退到状态码文案。
      }
      const message =
        typeof serverError === "object" &&
        serverError !== null &&
        typeof (serverError as { error?: unknown }).error === "string"
          ? (serverError as { error: string }).error
          : `浏览器宿主服务错误（HTTP ${response.status}）`;
      throw new BrowserUnavailableError(message);
    }
    const body: unknown = await response.json();
    const envelope = body as { ok: true; data: unknown } | { ok: false; error: string };
    if (!envelope.ok) throw new Error(envelope.error);
    return envelope.data;
  }
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function envPort(): number | undefined {
  const raw = process.env.PI_BROWSER_HOST_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function envToken(): string | undefined {
  const raw = process.env.PI_BROWSER_TOKEN;
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function envSessionToken(): string | undefined {
  const raw = process.env.PI_BROWSER_SESSION_TOKEN;
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function envSessionProjectId(): string | undefined {
  const raw = process.env.PI_BROWSER_SESSION_PROJECT_ID;
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function envSessionThreadId(): string | undefined {
  const raw = process.env.PI_BROWSER_SESSION_THREAD_ID;
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
