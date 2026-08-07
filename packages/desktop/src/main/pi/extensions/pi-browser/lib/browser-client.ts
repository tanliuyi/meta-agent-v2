/**
 * pi-browser 扩展的浏览器宿主客户端。
 *
 * pi extension 运行在 Electron-as-Node sidecar 进程，无法直接引用 main 进程的
 * BrowserManager；main 在 127.0.0.1 随机端口起本地 HTTP RPC（browser-host-server），
 * endpoint 与 token 经 worker 环境变量 PI_BROWSER_HOST_PORT / PI_BROWSER_TOKEN
 * 注入。本客户端封装 fetch 调用与 Result 解析。
 */

import type {
  BrowserAction,
  BrowserActionResult,
  BrowserHistoryEntry,
  BrowserInspectElementResult,
  BrowserNavigateResult,
  BrowserNavigationTargetResult,
  BrowserOpenTabResult,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserTab,
} from "../../../../../shared/browser-contracts.ts";
import type { BrowserSettingsSnapshot } from "../../../../../shared/browser-settings-contracts.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 130_000;
const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  openTab: 20_000,
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
  /** 覆盖全局 fetch（测试注入）。 */
  fetchImpl?: typeof fetch;
}

/** 与 main 进程 BrowserManager 的 RPC 客户端。 */
export class BrowserClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BrowserClientOptions = {}) {
    const port = options.port ?? envPort();
    const token = options.token ?? envToken();
    if (port === undefined || token === undefined) {
      throw new BrowserUnavailableError("浏览器宿主服务未就绪（缺少 PI_BROWSER_HOST_PORT/PI_BROWSER_TOKEN）");
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = token;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
