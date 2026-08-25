import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";
import { BrowserDataService } from "../src/main/browser/browser-data-service.ts";
import { BROWSER_PASSWORD_OFFER_BINDING } from "../src/main/browser/browser-form-scripts.ts";
import type {
  BrowserHostController,
  BrowserHostEvent,
  PickElementResult,
  WebContentsHostControllerOptions,
} from "../src/main/browser/browser-host-controller.ts";
import { StaleReferenceError } from "../src/main/browser/browser-host-controller.ts";
import { BrowserManager, type BrowserManagerOptions } from "../src/main/browser/browser-manager.ts";
import {
  type BrowserAction,
  type BrowserAnnotationBounds,
  type BrowserConsoleEntry,
  type BrowserCreateTabRequest,
  type BrowserEvaluateResult,
  type BrowserPendingDialog,
  type BrowserSessionIdentity,
  type BrowserSnapshot,
  type BrowserStateEvent,
  browserPartitionFor,
  browserSessionKey,
} from "../src/shared/browser-contracts.ts";

const electron = vi.hoisted(() => {
  const sessions = new Map<string, unknown>();
  const browserSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
  const popup = vi.fn();
  const buildFromTemplate = vi.fn(() => ({ popup }));
  const fromWebContents = vi.fn(() => undefined);
  const writeText = vi.fn();
  const writeImage = vi.fn();
  const createFromDataURL = vi.fn(() => ({ isEmpty: () => false }));
  return {
    sessions,
    browserSession,
    popup,
    buildFromTemplate,
    fromWebContents,
    writeText,
    writeImage,
    createFromDataURL,
  };
});

vi.mock("electron", () => ({
  webContents: { fromId: () => null },
  session: {
    fromPartition: (partition: string) => {
      let existing = electron.sessions.get(partition);
      if (!existing) {
        existing = {
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          clearStorageData: vi.fn().mockResolvedValue(undefined),
          clearCache: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
          off: vi.fn(),
        };
        electron.sessions.set(partition, existing);
      }
      return existing;
    },
  },
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  Menu: { buildFromTemplate: electron.buildFromTemplate },
  clipboard: { writeText: electron.writeText, writeImage: electron.writeImage },
  nativeImage: { createFromDataURL: electron.createFromDataURL },
}));

/** 内存假宿主：记录调用、可手动触发事件。 */
class FakeHost implements BrowserHostController {
  navigationError: Error | undefined;
  navigatedUrls: string[] = [];
  screenshotData: { dataUrl: string; width: number; height: number } = {
    dataUrl: "data:image/png;base64,AAAA",
    width: 100,
    height: 80,
  };
  clearCount = 0;
  backCount = 0;
  forwardCount = 0;
  reloadCount = 0;
  disposed = false;
  snapshotCalls: Array<{ withScreenshot: boolean }> = [];
  performedActions: BrowserAction[] = [];
  updatedSettings: Array<{ cdpTimeoutMs: number; maxSnapshotNodes: number }> = [];
  runtimeBindings: string[] = [];
  private readonly eventListeners = new Set<(event: BrowserHostEvent) => void>();

  onEvent(cb: (event: BrowserHostEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  emit(event: BrowserHostEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  navigate(url: string): Promise<void> {
    this.navigatedUrls.push(url);
    return this.navigationError ? Promise.reject(this.navigationError) : Promise.resolve();
  }

  goBack(): Promise<void> {
    this.backCount += 1;
    return Promise.resolve();
  }

  goForward(): Promise<void> {
    this.forwardCount += 1;
    return Promise.resolve();
  }

  reload(): Promise<void> {
    this.reloadCount += 1;
    return Promise.resolve();
  }

  getNavigationState(): { activeIndex: number; entries: Array<{ url: string; title: string }> } {
    return {
      activeIndex: 1,
      entries: [
        { url: "https://example.com/previous", title: "Previous" },
        { url: "https://example.com/current", title: "Current" },
        { url: "https://example.com/next", title: "Next" },
      ],
    };
  }

  captureScreenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    return Promise.resolve(this.screenshotData);
  }

  snapshot(opts: { withScreenshot: boolean }): Promise<BrowserSnapshot> {
    this.snapshotCalls.push(opts);
    return Promise.resolve({
      url: "about:blank",
      title: "",
      timestamp: 0,
      viewport: { width: 800, height: 600, dpr: 1 },
      tree: [],
      screenshot: opts.withScreenshot ? "data:image/png;base64,AAAA" : null,
    });
  }

  performAction(action: BrowserAction): Promise<{ url?: string; title?: string }> {
    this.performedActions.push(action);
    if (action.type === "click" && action.elementIndex === 999) {
      return Promise.reject(new StaleReferenceError());
    }
    return Promise.resolve({});
  }

  inspectElement(_elementIndex: number): BrowserSnapshot["tree"][number] | null {
    return null;
  }

  pickElement(x: number, y: number): Promise<PickElementResult> {
    return Promise.resolve({
      ok: true,
      selector: `#fake-${x}-${y}`,
      bounds: { x, y, width: 10, height: 10 },
      tag: "button",
      name: "fake",
    });
  }

  resolveSelectorBounds(_selector: string): Promise<BrowserAnnotationBounds | null> {
    return Promise.resolve({ x: 1, y: 2, width: 10, height: 10 });
  }

  clearData(): Promise<void> {
    this.clearCount += 1;
    return Promise.resolve();
  }

  updateSettings(options: { cdpTimeoutMs: number; maxSnapshotNodes: number }): void {
    this.updatedSettings.push(options);
  }

  cancelPendingOperations(): void {}

  async addRuntimeBinding(name: string): Promise<void> {
    this.runtimeBindings.push(name);
  }

  async readConsoleLogs(_options?: {
    filter?: string;
    levels?: BrowserConsoleEntry["level"][];
    limit?: number;
  }): Promise<BrowserConsoleEntry[]> {
    return [];
  }

  getPendingDialog(): BrowserPendingDialog | null {
    return null;
  }

  async handleDialog(_action: "accept" | "dismiss", _promptText?: string): Promise<void> {}

  async evaluate(_expression: string): Promise<BrowserEvaluateResult> {
    return { ok: true, value: "undefined", type: "undefined" };
  }

  async pressKey(_keySequence: string): Promise<void> {}

  async waitFor(_options: {
    state?: "load" | "domcontentloaded" | "networkidle";
    timeoutMs?: number;
    url?: string;
  }): Promise<void> {}

  async readCdpEvents(_options?: {
    methods?: string[];
    limit?: number;
  }): Promise<Array<{ method: string; params?: Record<string, unknown> }>> {
    return [];
  }

  async clipboardReadText(): Promise<string> {
    return "";
  }

  async clipboardWriteText(_text: string): Promise<void> {}

  async locatorAction(
    _selector: string,
    _action: string,
    _params?: {
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
  > {
    return { ok: true };
  }

  async uploadFile(_selector: string, _filePath: string): Promise<void> {}

  async clickPoint(_x: number, _y: number, _keys?: string[]): Promise<void> {}

  async cdpSend(_method: string, _params?: Record<string, unknown>): Promise<unknown> {
    return {};
  }

  async expectNavigation(_timeoutMs?: number): Promise<void> {}

  async dragPath(_points: Array<{ x: number; y: number }>): Promise<void> {}

  async moveMouse(_x: number, _y: number): Promise<void> {}

  async dblclickPoint(_x: number, _y: number): Promise<void> {}

  async contentExport(): Promise<string> {
    return "";
  }

  async downloadEvents(): Promise<Array<{ url: string; filename: string; path: string | null }>> {
    return [];
  }

  dispose(): void {
    this.disposed = true;
  }
}

interface Setup {
  manager: BrowserManager;
  hosts: Map<number, FakeHost>;
  hostOptions: Map<number, WebContentsHostControllerOptions>;
  states: BrowserStateEvent[];
}

const SESSION_A: BrowserSessionIdentity = { projectId: "proj-a", threadId: "thread-a" };
const SESSION_B: BrowserSessionIdentity = { projectId: "proj-a", threadId: "thread-b" };
const SESSION_C: BrowserSessionIdentity = { projectId: "proj-b", threadId: "thread-c" };

function fakeWebContents(
  contentsSession: Electron.Session,
  hostWebContents: WebContents | null = { id: 9_001 } as WebContents,
  url = "about:blank",
): WebContents {
  return {
    session: contentsSession,
    hostWebContents,
    getURL: () => url,
    getLastWebPreferences: () => ({}),
    getTitle: () => "",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    on: () => ({}) as WebContents,
    removeListener: () => ({}) as WebContents,
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve(undefined),
    disposeGuestListeners: () => undefined,
  } as unknown as WebContents;
}

function sessionFor(identity: BrowserSessionIdentity): Electron.Session {
  return (electron.sessions.get(browserPartitionFor(identity)) ?? electron.browserSession) as Electron.Session;
}

function setup(options: Partial<BrowserManagerOptions> = {}): Setup {
  const hosts = new Map<number, FakeHost>();
  const hostOptions = new Map<number, WebContentsHostControllerOptions>();
  const states: BrowserStateEvent[] = [];
  const manager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
    ...options,
    onStateChanged: (event) => states.push(event),
    createHost: (webContentsId, options) => {
      const host = new FakeHost();
      hosts.set(webContentsId, host);
      hostOptions.set(webContentsId, options ?? {});
      return host;
    },
    fromWebContentsId:
      options.fromWebContentsId ??
      ((webContentsId: number) => {
        // 按 webContentsId 前缀区分 guest 属于哪个会话（101-199 → A，201-299 → B，301-399 → C）。
        if (webContentsId >= 300) return fakeWebContents(sessionFor(SESSION_C));
        if (webContentsId >= 200) return fakeWebContents(sessionFor(SESSION_B));
        return fakeWebContents(sessionFor(SESSION_A));
      }),
  });
  manager.registerSession(SESSION_A);
  manager.registerSession(SESSION_B);
  manager.registerSession(SESSION_C);
  return { manager, hosts, hostOptions, states };
}

/** openTab 会在广播建 tab 请求前 await 设置加载（真实文件 IO），轮询等待请求到达。 */
async function waitForRequests(requests: BrowserCreateTabRequest[], count: number): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (requests.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("BrowserManager 会话隔离", () => {
  test("attach 注册 tab 并广播携带 sessionKey 的状态", async () => {
    const { manager, hosts, states } = setup();

    const result = await manager.attach(SESSION_A, 101);

    expect(result).toMatchObject({ ok: true, tab: { tabId: 1, url: "about:blank" } });
    expect(hosts.has(101)).toBe(true);
    expect(manager.tabsList(SESSION_A)).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({
      sessionKey: browserSessionKey(SESSION_A),
      activeTabId: 1,
      tabs: [{ tabId: 1 }],
    });
  });

  test("双会话 profile/tab 状态完全隔离", async () => {
    const hosts = new Map<number, FakeHost>();
    const states: BrowserStateEvent[] = [];
    const sessionA = sessionFor(SESSION_A);
    const sessionB = sessionFor(SESSION_B);
    const managerWithPerSession = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      onStateChanged: (event) => states.push(event),
      createHost: (webContentsId, _options) => {
        const host = new FakeHost();
        hosts.set(webContentsId, host);
        return host;
      },
      fromWebContentsId: (webContentsId) => {
        // 按 webContentsId 前缀区分属于哪个会话的 guest（101-199 → A，201-299 → B）。
        if (webContentsId < 200) return fakeWebContents(sessionA);
        return fakeWebContents(sessionB);
      },
    });
    managerWithPerSession.registerSession(SESSION_A);
    managerWithPerSession.registerSession(SESSION_B);

    await managerWithPerSession.attach(SESSION_A, 101);
    await managerWithPerSession.attach(SESSION_A, 102);
    await managerWithPerSession.attach(SESSION_B, 201);

    // 各自独立的 tab 列表与 tabId 编号。
    expect(managerWithPerSession.tabsList(SESSION_A).map((tab) => tab.tabId)).toEqual([1, 2]);
    expect(managerWithPerSession.tabsList(SESSION_B).map((tab) => tab.tabId)).toEqual([1]);
    expect(managerWithPerSession.tabsList(SESSION_C)).toEqual([]);

    // 各自独立的 active tab；A 的 agent 操作不能改变 B 的 active tab。
    managerWithPerSession.selectTab(SESSION_A, 2);
    managerWithPerSession.selectTab(SESSION_B, 1);
    managerWithPerSession.snapshot(SESSION_A, 2, {}, "agent"); // activateAgentTab(A, 2)
    expect(managerWithPerSession.activeTab(SESSION_A)?.tabId).toBe(2);
    expect(managerWithPerSession.activeTab(SESSION_B)?.tabId).toBe(1);

    // 广播带各自 sessionKey。
    const sessionKeys = new Set(states.map((state) => state.sessionKey));
    expect(sessionKeys).toEqual(new Set([browserSessionKey(SESSION_A), browserSessionKey(SESSION_B)]));
  });

  test("双会话使用不同 Electron partition（cookie/cache 隔离）", () => {
    expect(browserPartitionFor(SESSION_A)).not.toBe(browserPartitionFor(SESSION_B));
    expect(browserPartitionFor(SESSION_A)).toMatch(/^persist:browser-[0-9a-f]{16}$/);
    expect(browserPartitionFor(SESSION_B)).toMatch(/^persist:browser-[0-9a-f]{16}$/);
    // 同一身份幂等。
    expect(browserPartitionFor(SESSION_A)).toBe(browserPartitionFor({ projectId: "proj-a", threadId: "thread-a" }));
  });

  test("跨会话 tab 访问被拒绝且不产生副作用", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);

    // 用 B 的身份访问 A 的 tab：一律拒绝。
    await expect(manager.navigate(SESSION_B, 1, "https://example.com/")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("不存在"),
    });
    await expect(manager.snapshot(SESSION_B, 1)).resolves.toMatchObject({ ok: false });
    await expect(manager.screenshot(SESSION_B, 1)).resolves.toMatchObject({ ok: false });
    await expect(manager.action(SESSION_B, 1, { type: "click", elementIndex: 1 })).resolves.toMatchObject({
      ok: false,
    });
    await expect(manager.goBack(SESSION_B, 1)).resolves.toMatchObject({ ok: false });
    expect(manager.navigationTarget(SESSION_B, 1, "back")).toMatchObject({ ok: false });
    expect(manager.inspectElement(SESSION_B, 1, 1)).toMatchObject({ ok: false });
    await expect(manager.pickAnnotationTarget(SESSION_B, 1, 10, 10)).resolves.toMatchObject({ ok: false });

    // A 的宿主没有被任何 B 操作触碰。
    expect(hosts.get(101)?.navigatedUrls).toEqual([]);
    expect(hosts.get(101)?.performedActions).toEqual([]);
    expect(hosts.get(101)?.backCount).toBe(0);
  });

  test("错误 partition 的 guest attach 被拒绝且不留孤儿", async () => {
    const { hosts } = setup();
    // guest 属于 B 的分区，但以 A 的身份 attach。
    const managerWithForeign = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      createHost: (webContentsId, options) => {
        const host = new FakeHost();
        hosts.set(webContentsId, host);
        hostOptions.set(webContentsId, options ?? {});
        return host;
      },
      fromWebContentsId: () => fakeWebContents(sessionFor(SESSION_B)),
    });
    managerWithForeign.registerSession(SESSION_A);

    const result = await managerWithForeign.attach(SESSION_A, 101);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("分区") });
    expect(managerWithForeign.tabsList(SESSION_A)).toHaveLength(0);
    expect(hosts.has(101)).toBe(false);
  });

  test("openTab 广播带 sessionKey 的建 tab 请求，attach 后按会话 resolve", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager, hosts } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    const openPromise = manager.openTab(SESSION_A, "https://example.com");
    await waitForRequests(requests, 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://example.com/",
      sessionKey: browserSessionKey(SESSION_A),
    });
    const requestId = requests[0]!.requestId;

    const attachResult = await manager.attach(SESSION_A, 101, requestId);
    expect(attachResult.ok).toBe(true);

    const result = await openPromise;
    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.navigatedUrls).toEqual(["https://example.com/"]);
  });

  test("onPopup 转应用内新 tab：默认站点策略下也能打开（用户操作不受 Agent 审批限制）", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager, hosts, hostOptions } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    const attached = await manager.attach(SESSION_A, 101);
    expect(attached.ok).toBe(true);
    const onPopup = hostOptions.get(101)?.onPopup;
    expect(onPopup).toBeDefined();

    onPopup!("https://popup.example/");
    await waitForRequests(requests, 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://popup.example/",
      sessionKey: browserSessionKey(SESSION_A),
    });

    const attachResult = await manager.attach(SESSION_A, 102, requests[0]!.requestId);
    expect(attachResult.ok).toBe(true);
    expect(hosts.get(102)?.navigatedUrls).toEqual(["https://popup.example/"]);
  });

  test("双会话 pending create 请求互相隔离；未知 requestId attach 拒绝", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager, hosts } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    const openA = manager.openTab(SESSION_A, "https://a.example/");
    const openB = manager.openTab(SESSION_B, "https://b.example/");
    await waitForRequests(requests, 2);
    const requestA = requests.find((request) => request.sessionKey === browserSessionKey(SESSION_A))!;
    const requestB = requests.find((request) => request.sessionKey === browserSessionKey(SESSION_B))!;
    expect(requestA).toBeDefined();
    expect(requestB).toBeDefined();
    expect(requestA.requestId).not.toBe(requestB.requestId);

    // 未知 requestId 的 attach 被拒绝且不留孤儿。
    await expect(manager.attach(SESSION_A, 101, 999)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("未知的建 tab 请求"),
    });
    expect(manager.tabsList(SESSION_A)).toHaveLength(0);

    // A 的 attach 只 resolve A 的 pending；B 的 openTab 仍挂起。
    await manager.attach(SESSION_A, 101, requestA.requestId);
    await expect(openA).resolves.toMatchObject({ ok: true });
    let settledB = false;
    void openB.then(() => {
      settledB = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settledB).toBe(false);

    // B 正确 attach 后 resolve 自己的请求。
    await manager.attach(SESSION_B, 201, requestB.requestId);
    await expect(openB).resolves.toMatchObject({ ok: true });
    expect(hosts.get(101)?.navigatedUrls).toEqual(["https://a.example/"]);
    expect(hosts.get(201)?.navigatedUrls).toEqual(["https://b.example/"]);
  });

  test("openTab 可被 AbortSignal 取消：pending 清理且不留孤儿", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ onCreateTabRequest: (request) => requests.push(request) });
    const controller = new AbortController();

    const openPromise = manager.openTab(SESSION_A, "https://example.com", "agent", controller.signal);
    await waitForRequests(requests, 1);
    controller.abort();
    await expect(openPromise).resolves.toMatchObject({ ok: false, error: "已取消" });

    // 迟到的 attach（带已取消的 requestId）被拒绝。
    const late = await manager.attach(SESSION_A, 101, requests[0]!.requestId);
    expect(late).toMatchObject({ ok: false, error: expect.stringContaining("未知的建 tab 请求") });
    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
  });

  test("openTab 在 attach 前已 abort 时直接取消", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ onCreateTabRequest: (request) => requests.push(request) });
    const controller = new AbortController();
    controller.abort();

    await expect(manager.openTab(SESSION_A, "https://example.com", "agent", controller.signal)).resolves.toMatchObject({
      ok: false,
      error: "已取消",
    });
    expect(requests).toHaveLength(0);
  });

  test("同一 webContentsId 重复 attach 幂等返回同一 tab", async () => {
    const { manager, hosts } = setup();

    const first = await manager.attach(SESSION_A, 101);
    const second = await manager.attach(SESSION_A, 101);

    expect(second).toMatchObject({ ok: true, tab: { tabId: first.ok === true ? first.tab.tabId : -1 } });
    expect(hosts.size).toBe(1);
    expect(manager.tabsList(SESSION_A)).toHaveLength(1);
  });

  test("webContents 不存在时 attach 返回错误", async () => {
    const manager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      fromWebContentsId: () => null,
    });
    manager.registerSession(SESSION_A);

    const result = await manager.attach(SESSION_A, 999);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("不存在") });
  });

  test("attach 时 guest 初始 URL 尚未就绪（getURL 空串）视为 about:blank 放行", async () => {
    // did-attach 触发时 guest 的 URL 可能尚未提交（getURL() 返回空串）；
    // 此时必须放行，否则 attach 失败导致 renderer 移除 webview、openTab 挂起。
    const { manager } = setup({
      fromWebContentsId: () => fakeWebContents(sessionFor(SESSION_A), {} as WebContents, ""),
    });
    const result = await manager.attach(SESSION_A, 101);
    expect(result).toMatchObject({ ok: true, tab: { url: "about:blank" } });
    expect(manager.tabsList(SESSION_A)).toHaveLength(1);
  });

  test("attach 仍拒绝非空且非 http/https 的初始 URL", async () => {
    const { manager } = setup({
      fromWebContentsId: () => fakeWebContents(sessionFor(SESSION_A), {} as WebContents, "chrome://settings"),
    });
    const result = await manager.attach(SESSION_A, 101);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("URL 不符合") });
    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
  });

  test("未注册会话的 RPC 操作 fail-closed", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const unknown: BrowserSessionIdentity = { projectId: "proj-x", threadId: "thread-x" };

    expect(manager.isKnownSession(unknown)).toBe(false);
    await expect(manager.navigate(unknown, 1, "https://example.com/")).resolves.toMatchObject({
      ok: false,
      error: "未知的浏览器会话",
    });
    await expect(manager.openTab(unknown, "https://example.com/")).resolves.toMatchObject({
      ok: false,
      error: "未知的浏览器会话",
    });
    expect(hosts.get(101)?.navigatedUrls).toEqual([]);
  });

  test("retireSession 清理会话状态并撤销身份，重新注册后可重建", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.addAnnotation(SESSION_A, 1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "t",
    });
    const host = hosts.get(101)!;
    states.length = 0;
    const capability = manager.registerSession(SESSION_A);
    manager.revokeSessionCapability(capability);

    manager.retireSession(SESSION_A, 1);

    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
    expect(manager.browserHistory(SESSION_A)).toEqual([]);
    expect(manager.listAnnotations(SESSION_A, 1)).toEqual([]);
    expect(host.disposed).toBe(true);
    expect(states.at(-1)).toMatchObject({ sessionKey: browserSessionKey(SESSION_A), tabs: [], activeTabId: null });
    expect(manager.isKnownSession(SESSION_A)).toBe(false);

    // 重建：重新注册 identity 后再次 attach 正常。
    manager.registerSession(SESSION_A);
    const rebuilt = await manager.attach(SESSION_A, 102);
    expect(rebuilt.ok).toBe(true);
    expect(manager.tabsList(SESSION_A)).toHaveLength(1);
  });

  test("navigate 拒绝非法协议与非法 URL", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);

    await expect(manager.navigate(SESSION_A, 1, "file:///etc/passwd")).resolves.toMatchObject({ ok: false });
    await expect(manager.navigate(SESSION_A, 1, "ftp://example.com")).resolves.toMatchObject({ ok: false });
    await expect(manager.navigate(SESSION_A, 1, "not a url")).resolves.toMatchObject({ ok: false });
    expect(hosts.get(101)?.navigatedUrls).toEqual([]);
  });

  test("navigate 成功转发到宿主并规范化 URL", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);

    const result = await manager.navigate(SESSION_A, 1, "https://example.com");

    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.navigatedUrls).toEqual(["https://example.com/"]);
  });

  test("browser:// 特权 guest 永久限制导航且拒绝 Agent 页面操作", async () => {
    const internalContents = fakeWebContents(sessionFor(SESSION_A), { id: 9_001 } as WebContents, "browser://history");
    const { manager, hosts, hostOptions } = setup({ fromWebContentsId: () => internalContents });
    await manager.attach(SESSION_A, 101);

    const allowNavigation = hostOptions.get(101)?.allowNavigation;
    expect(allowNavigation?.("browser://passwords")).toBe(true);
    expect(allowNavigation?.("https://evil.example/")).toBe(false);

    const results = await Promise.all([
      manager.snapshot(SESSION_A, 1, {}, "agent"),
      manager.evaluate(SESSION_A, 1, "window.browserInternal.dataGet(true)"),
      manager.cdpSend(SESSION_A, 1, "Runtime.evaluate", { expression: "location.href='https://evil.example/'" }),
      manager.readCdpEvents(SESSION_A, 1),
    ]);
    for (const result of results) {
      expect(result).toEqual({ ok: false, error: "browser:// 内部页面仅供用户操作" });
    }
    expect(hosts.get(101)?.snapshotCalls).toEqual([]);
  });

  test("browser:// 特权 tab 不能直接导航到网站", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    hosts.get(101)?.emit({ type: "navigated", url: "browser://history", canGoBack: false, canGoForward: false });

    await expect(manager.navigate(SESSION_A, 1, "https://example.com/")).resolves.toEqual({
      ok: false,
      error: "browser:// 标签需要重建 webview 后才能导航到网站",
    });
    expect(hosts.get(101)?.navigatedUrls).toEqual([]);
  });

  test("用户与 Agent 均不能导航到 chrome 协议（Electron 无浏览器 UI 内置页）", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);

    for (const source of ["user", "agent"] as const) {
      await expect(manager.navigate(SESSION_A, 1, "chrome://downloads/", source)).resolves.toMatchObject({
        ok: false,
        error: "仅支持 http/https 链接",
      });
    }
    expect(hosts.get(101)?.navigatedUrls).toEqual([]);
  });

  test("copyScreenshot 将 PNG 写入系统剪贴板", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);

    await expect(manager.copyScreenshot(SESSION_A, 1)).resolves.toEqual({ ok: true });
    expect(electron.createFromDataURL).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(electron.writeImage).toHaveBeenCalledWith(expect.objectContaining({ isEmpty: expect.any(Function) }));
  });

  test("navigate 不存在的 tab 返回错误", async () => {
    const { manager } = setup();

    await expect(manager.navigate(SESSION_A, 42, "https://example.com")).resolves.toMatchObject({ ok: false });
  });

  test("宿主事件更新 tab 状态并广播", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;

    host.emit({ type: "navigated", url: "https://example.com/page", canGoBack: true, canGoForward: false });
    expect(manager.tabsList(SESSION_A)[0]).toMatchObject({ url: "https://example.com/page", canGoBack: true });

    host.emit({ type: "title-updated", title: "Example" });
    expect(manager.tabsList(SESSION_A)[0]?.title).toBe("Example");

    host.emit({ type: "loading-changed", loading: true });
    expect(manager.tabsList(SESSION_A)[0]?.loading).toBe(true);

    host.emit({ type: "navigated-in-page", url: "https://example.com/page#top" });
    expect(manager.tabsList(SESSION_A)[0]?.url).toBe("https://example.com/page#top");

    host.emit({ type: "crashed", reason: "crashed" });
    expect(manager.tabsList(SESSION_A)[0]).toMatchObject({ crashed: true, loading: false });

    expect(states).toHaveLength(1 + 5);
  });

  test("screenshot 成功返回 dataUrl", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);

    const result = await manager.screenshot(SESSION_A, 1);

    expect(result).toMatchObject({ ok: true, dataUrl: "data:image/png;base64,AAAA", width: 100, height: 80 });
  });

  test("screenshot 对崩溃或未知 tab 返回错误", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    hosts.get(101)!.emit({ type: "crashed", reason: "crashed" });

    await expect(manager.screenshot(SESSION_A, 1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("崩溃"),
    });
    await expect(manager.screenshot(SESSION_A, 42)).resolves.toMatchObject({ ok: false });
  });

  test("detach 移除 tab、释放宿主并广播；幂等", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;

    await manager.detach(SESSION_A, 101);
    await manager.detach(SESSION_A, 101);

    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
    expect(host.disposed).toBe(true);
    expect(states.at(-1)).toMatchObject({ activeTabId: null, tabs: [] });
  });

  test("selectTab 切换活跃 tab；未知 tab 返回 null", async () => {
    const { manager, states } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.attach(SESSION_A, 102);

    const selected = manager.selectTab(SESSION_A, 1);
    expect(selected?.tabId).toBe(1);
    expect(states.at(-1)?.activeTabId).toBe(1);
    expect(manager.selectTab(SESSION_A, 42)).toBeNull();
  });

  test("关闭最后一个活跃 tab 后活跃回退到左侧相邻 tab", async () => {
    const { manager, states } = setup();
    await manager.attach(SESSION_A, 101); // tab 1（active）
    await manager.attach(SESSION_A, 102); // tab 2（active）

    await manager.detach(SESSION_A, 102);

    expect(states.at(-1)?.activeTabId).toBe(1);
    expect(manager.tabsList(SESSION_A).map((tab) => tab.tabId)).toEqual([1]);
  });

  test("关闭活跃 tab 后选中相邻 tab：优先右侧，最后关闭时选左侧", async () => {
    const { manager, states } = setup();
    await manager.attach(SESSION_A, 101); // tab 1
    await manager.attach(SESSION_A, 102); // tab 2
    await manager.attach(SESSION_A, 103); // tab 3

    // 关闭中间活跃 tab：选中右侧相邻 tab 3
    manager.selectTab(SESSION_A, 2);
    await manager.detach(SESSION_A, 102);
    expect(states.at(-1)?.activeTabId).toBe(3);

    // 关闭最后一个活跃 tab：选中左侧相邻 tab 1
    manager.selectTab(SESSION_A, 3);
    await manager.detach(SESSION_A, 103);
    expect(states.at(-1)?.activeTabId).toBe(1);

    // 关闭非活跃 tab：保持当前活跃不变
    manager.selectTab(SESSION_A, 1);
    await manager.attach(SESSION_A, 104); // tab 4
    await manager.detach(SESSION_A, 104);
    expect(states.at(-1)?.activeTabId).toBe(1);
    expect(manager.tabsList(SESSION_A).map((tab) => tab.tabId)).toEqual([1]);
  });

  test("clearSessionData 只清除本会话分区", async () => {
    const { manager } = setup();
    const aSession = sessionFor(SESSION_A);
    const bSession = sessionFor(SESSION_B);

    await manager.clearSessionData(SESSION_A);

    expect(aSession.clearStorageData).toHaveBeenCalled();
    expect(aSession.clearCache).toHaveBeenCalled();
    expect(bSession.clearStorageData).not.toHaveBeenCalled();
  });

  test("clearAllData 清除全部会话分区（设置页入口）", async () => {
    const { manager } = setup();

    await manager.clearAllData();

    expect(sessionFor(SESSION_A).clearStorageData).toHaveBeenCalled();
    expect(sessionFor(SESSION_B).clearStorageData).toHaveBeenCalled();
  });

  test("dispose 释放全部宿主且不再广播", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.attach(SESSION_B, 201);
    const hostA = hosts.get(101)!;
    const hostB = hosts.get(201)!;
    states.length = 0;

    manager.dispose();

    expect(hostA.disposed).toBe(true);
    expect(hostB.disposed).toBe(true);
    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
    expect(manager.tabsList(SESSION_B)).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  test("retireSession 与 dispose 都移除 guest 表单监听", async () => {
    const retiredRemoveListener = vi.fn(() => ({}) as WebContents);
    const retiredGuest = fakeWebContents(sessionFor(SESSION_A));
    retiredGuest.removeListener = retiredRemoveListener;
    const retired = setup({ fromWebContentsId: () => retiredGuest });
    await retired.manager.attach(SESSION_A, 101);
    const retiredCapability = retired.manager.registerSession(SESSION_A);
    retired.manager.revokeSessionCapability(retiredCapability);
    retired.manager.retireSession(SESSION_A, 1);
    expect(retiredRemoveListener).toHaveBeenCalledWith("did-finish-load", expect.any(Function));

    const disposedRemoveListener = vi.fn(() => ({}) as WebContents);
    const disposedGuest = fakeWebContents(sessionFor(SESSION_A));
    disposedGuest.removeListener = disposedRemoveListener;
    const disposed = setup({ fromWebContentsId: () => disposedGuest });
    await disposed.manager.attach(SESSION_A, 102);
    disposed.manager.dispose();
    expect(disposedRemoveListener).toHaveBeenCalledWith("did-finish-load", expect.any(Function));
  });

  test("始终允许策略放行点击后的跨站重定向", async () => {
    const { manager, hostOptions } = setup();
    const initial = await manager.getSettingsSnapshot();
    const saved = await manager.saveSettings({
      expectedRevision: initial.revision,
      settings: { ...initial.settings, siteApproval: "always-allow" },
    });
    expect(saved.status).toBe("saved");

    await manager.attach(SESSION_A, 101);
    const guard = hostOptions.get(101)?.onAgentNavigation;
    expect(guard).toBeDefined();
    expect(guard?.("https://redirect.example/", "https://source.example/", "https://approved.example/")).toBe(true);
  });

  test("设置快照与保存透传到设置服务（全局）", async () => {
    const { manager } = setup();

    const snapshot = await manager.getSettingsSnapshot();
    expect(snapshot.exists).toBe(false);
    expect(snapshot.settings.restoreTabsOnLaunch).toBe(true);

    const saved = await manager.saveSettings({
      expectedRevision: snapshot.revision,
      settings: { ...snapshot.settings, restoreTabsOnLaunch: false },
    });
    expect(saved.status).toBe("saved");
  });

  test("attach 使用运行时 CDP 设置，保存后更新全部会话既有宿主", async () => {
    const { manager, hosts, hostOptions } = setup();
    const initial = await manager.getSettingsSnapshot();
    const saved = await manager.saveSettings({
      expectedRevision: initial.revision,
      settings: { ...initial.settings, maxSnapshotNodes: 321, cdpTimeoutMs: 2_000 },
    });
    expect(saved.status).toBe("saved");

    await manager.attach(SESSION_A, 101);
    expect(hostOptions.get(101)).toMatchObject({ maxSnapshotNodes: 321, cdpTimeoutMs: 2_000 });

    if (saved.status !== "saved") throw new Error("settings save failed");
    const updated = await manager.saveSettings({
      expectedRevision: saved.snapshot.revision,
      settings: { ...saved.snapshot.settings, maxSnapshotNodes: 444, cdpTimeoutMs: 3_000 },
    });
    expect(updated.status).toBe("saved");
    expect(hosts.get(101)?.updatedSettings.at(-1)).toEqual({ maxSnapshotNodes: 444, cdpTimeoutMs: 3_000 });
  });

  test("媒体权限按默认值和站点覆盖同时约束 check/request", async () => {
    const { manager } = setup();
    const browserSession = sessionFor(SESSION_A) as unknown as {
      setPermissionRequestHandler: { mock: { calls: unknown[][] } };
      setPermissionCheckHandler: { mock: { calls: unknown[][] } };
    };
    const requestHandler = browserSession.setPermissionRequestHandler.mock.calls.at(-1)?.[0] as (
      webContents: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl: string; securityOrigin?: string; mediaTypes?: Array<"video" | "audio"> },
    ) => void;
    const checkHandler = browserSession.setPermissionCheckHandler.mock.calls.at(-1)?.[0] as (
      webContents: WebContents | null,
      permission: string,
      requestingOrigin: string,
      details: { mediaType?: "video" | "audio" | "unknown" },
    ) => boolean;

    const initial = await manager.getSettingsSnapshot();
    const denied: boolean[] = [];
    requestHandler({} as WebContents, "media", (granted) => denied.push(granted), {
      requestingUrl: "https://example.com/",
      securityOrigin: "https://example.com",
      mediaTypes: ["video"],
    });
    expect(denied).toEqual([false]);
    expect(checkHandler(null, "media", "https://example.com", { mediaType: "video" })).toBe(false);

    const saved = await manager.saveSettings({
      expectedRevision: initial.revision,
      settings: {
        ...initial.settings,
        mediaDefault: "allow",
        mediaPermissions: [
          { site: "example.com", camera: "allow", microphone: "allow" },
          { site: "blocked.example.com", camera: "deny", microphone: "deny" },
        ],
      },
    });
    expect(saved.status).toBe("saved");

    const allowed: boolean[] = [];
    requestHandler({} as WebContents, "media", (granted) => allowed.push(granted), {
      requestingUrl: "https://example.com/",
      securityOrigin: "https://example.com",
      mediaTypes: ["video", "audio"],
    });
    expect(allowed).toEqual([true]);
    expect(checkHandler(null, "media", "https://example.com", { mediaType: "audio" })).toBe(true);

    const blocked: boolean[] = [];
    requestHandler({} as WebContents, "media", (granted) => blocked.push(granted), {
      requestingUrl: "https://blocked.example.com/",
      securityOrigin: "https://blocked.example.com",
      mediaTypes: ["video"],
    });
    expect(blocked).toEqual([false]);
    expect(checkHandler(null, "media", "https://blocked.example.com", { mediaType: "video" })).toBe(false);
  });

  test("destroyed 事件移除 tab 并释放宿主，活跃回退", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.attach(SESSION_A, 102);
    manager.selectTab(SESSION_A, 1);
    const host1 = hosts.get(101)!;
    const host2 = hosts.get(102)!;

    host2.emit({ type: "destroyed" });

    expect(manager.tabsList(SESSION_A).map((tab) => tab.tabId)).toEqual([1]);
    expect(host2.disposed).toBe(true);
    expect(states.at(-1)?.activeTabId).toBe(1);

    host1.emit({ type: "destroyed" });
    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
    expect(states.at(-1)?.activeTabId).toBeNull();
    expect(host1.disposed).toBe(true);
  });

  test("activeTab 返回当前活跃 tab；无 tab 返回 null", async () => {
    const { manager } = setup();
    expect(manager.activeTab(SESSION_A)).toBeNull();

    await manager.attach(SESSION_A, 101);
    expect(manager.activeTab(SESSION_A)).toMatchObject({ tabId: 1 });

    manager.selectTab(SESSION_A, 1);
    expect(manager.activeTab(SESSION_A)?.tabId).toBe(1);
  });

  test("openTab attach 后导航失败时返回失败且清理 tab", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const host = new FakeHost();
    host.navigationError = new Error("导航失败");
    const manager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      onCreateTabRequest: (request) => requests.push(request),
      createHost: () => host,
      fromWebContentsId: () => fakeWebContents(sessionFor(SESSION_A)),
    });
    manager.registerSession(SESSION_A);

    const pending = manager.openTab(SESSION_A, "https://example.com");
    await waitForRequests(requests, 1);
    const requestId = requests[0]!.requestId;
    const attach = await manager.attach(SESSION_A, 101, requestId);

    expect(attach).toMatchObject({ ok: false, error: "导航失败" });
    await expect(pending).resolves.toMatchObject({ ok: false, error: "导航失败" });
    expect(manager.tabsList(SESSION_A)).toHaveLength(0);
  });

  test("openTab 拒绝非法 URL", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    await expect(manager.openTab(SESSION_A, "file:///etc/passwd")).resolves.toMatchObject({ ok: false });
    expect(requests).toHaveLength(0);
  });

  test("openTab 无协议输入补 https://", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    const pending = manager.openTab(SESSION_A, "example.com/foo");
    await waitForRequests(requests, 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://example.com/foo" });
    const requestId = requests[0]!.requestId;
    await manager.attach(SESSION_A, 101, requestId);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  test("navigationTarget 返回准确的 back/forward 目标", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);

    expect(manager.navigationTarget(SESSION_A, 1, "back")).toMatchObject({
      ok: true,
      target: { url: "https://example.com/previous" },
    });
    expect(manager.navigationTarget(SESSION_A, 1, "forward")).toMatchObject({
      ok: true,
      target: { url: "https://example.com/next" },
    });
  });

  test("snapshot 透传到宿主", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);

    const result = await manager.snapshot(SESSION_A, 1, { withScreenshot: true });

    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.snapshotCalls).toEqual([{ withScreenshot: true }]);
  });

  test("snapshot 对未知 tab 或崩溃 tab 返回错误", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    hosts.get(101)!.emit({ type: "crashed", reason: "crashed" });

    await expect(manager.snapshot(SESSION_A, 1)).resolves.toMatchObject({ ok: false });
    await expect(manager.snapshot(SESSION_A, 42)).resolves.toMatchObject({ ok: false });
  });

  test("action 透传到宿主", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const action: BrowserAction = { type: "type", elementIndex: 2, text: "hello", submit: true };

    const result = await manager.action(SESSION_A, 1, action);

    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.performedActions).toEqual([action]);
  });

  test("goBack/goForward/reload 透传到宿主", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);

    await expect(manager.goBack(SESSION_A, 1)).resolves.toMatchObject({ ok: true });
    await expect(manager.goForward(SESSION_A, 1)).resolves.toMatchObject({ ok: true });
    await expect(manager.reload(SESSION_A, 1)).resolves.toMatchObject({ ok: true });
    const host = hosts.get(101)!;
    expect(host.backCount).toBe(1);
    expect(host.forwardCount).toBe(1);
    expect(host.reloadCount).toBe(1);

    await expect(manager.goBack(SESSION_A, 42)).resolves.toMatchObject({ ok: false });
  });

  test("action 的 stale ref 错误映射为 staleRef 标记", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);

    const result = await manager.action(SESSION_A, 1, { type: "click", elementIndex: 999 });

    expect(result).toMatchObject({ ok: false, staleRef: true });
  });

  test("访问历史按会话隔离：导航记录、同 URL 合并、tab 关闭清理", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.attach(SESSION_B, 201);
    const hostA = hosts.get(101)!;
    const hostB = hosts.get(201)!;

    hostA.emit({ type: "navigated", url: "about:blank", canGoBack: false, canGoForward: false });
    hostA.emit({ type: "navigated", url: "browser://history", canGoBack: true, canGoForward: false });
    expect(manager.browserHistory(SESSION_A)).toEqual([]);

    hostA.emit({ type: "navigated", url: "https://example.com/a", canGoBack: false, canGoForward: false });
    hostA.emit({ type: "title-updated", title: "A 页面" });
    hostA.emit({ type: "navigated", url: "https://example.com/b", canGoBack: true, canGoForward: false });
    // 同一 tab 重复导航同 URL：不重复记录。
    hostA.emit({ type: "navigated", url: "https://example.com/b", canGoBack: true, canGoForward: false });

    expect(manager.browserHistory(SESSION_A)).toHaveLength(2);
    expect(manager.browserHistory(SESSION_A)[0]).toMatchObject({ url: "https://example.com/b" });
    expect(manager.browserHistory(SESSION_A)[1]).toMatchObject({ url: "https://example.com/a", title: "A 页面" });
    expect(manager.browserHistory(SESSION_B)).toEqual([]);

    // B 导航到相同 URL：不合并到 A 的历史（会话隔离）。
    hostB.emit({ type: "navigated", url: "https://example.com/a", canGoBack: false, canGoForward: false });
    expect(manager.browserHistory(SESSION_B)).toHaveLength(1);
    expect(manager.browserHistory(SESSION_A)).toHaveLength(2);
  });

  test("标注按会话隔离：pick/add/list/remove/resolve 全链路", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.attach(SESSION_B, 201);

    const pick = await manager.pickAnnotationTarget(SESSION_A, 1, 30, 40);
    expect(pick).toMatchObject({ ok: true, selector: "#fake-30-40", bounds: { x: 30, y: 40 } });

    const added = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#fake-30-40",
      tag: "button",
      bounds: { x: 30, y: 40, width: 10, height: 10 },
      text: "按钮文案要改",
    });
    expect(added).toMatchObject({ selector: "#fake-30-40", tag: "button", text: "按钮文案要改" });

    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(1);
    expect(manager.listAnnotations(SESSION_B, 1)).toHaveLength(0);
    await expect(manager.resolveAnnotationBounds(SESSION_A, 1, added!.id)).resolves.toEqual({
      x: 1,
      y: 2,
      width: 10,
      height: 10,
    });

    await manager.removeAnnotation(SESSION_A, 1, added!.id);
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);

    // tab 不存在时 pick 报错、add 返回 null。
    await expect(manager.pickAnnotationTarget(SESSION_A, 42, 1, 1)).resolves.toMatchObject({ ok: false });
    await expect(
      manager.addAnnotation(SESSION_A, 42, {
        selector: "#x",
        tag: "div",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        text: "x",
      }),
    ).resolves.toBeNull();
  });

  test("标注随 tab 关闭清理", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.addAnnotation(SESSION_A, 1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "t",
    });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(1);

    await manager.detach(SESSION_A, 101);
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);
    expect(hosts.get(101)?.disposed).toBe(true);
  });

  test("updateAnnotation 原位更新文本并保持 id/createdAt/selector/bounds/tag", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);
    const added = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 1, y: 2, width: 10, height: 10 },
      text: "原文本",
    });
    expect(added).not.toBeNull();

    const updated = await manager.updateAnnotation(SESSION_A, 1, added!.id, { text: "新文本" });
    expect(updated).toMatchObject({
      id: added!.id,
      tabId: 1,
      selector: "#a",
      tag: "button",
      bounds: { x: 1, y: 2, width: 10, height: 10 },
      text: "新文本",
      createdAt: added!.createdAt,
    });
    const listed = manager.listAnnotations(SESSION_A, 1);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: added!.id, text: "新文本" });

    // 未知 id / 未知 tab 静默返回 null，不影响已有标注。
    await expect(manager.updateAnnotation(SESSION_A, 1, "missing", { text: "x" })).resolves.toBeNull();
    await expect(manager.updateAnnotation(SESSION_A, 42, added!.id, { text: "x" })).resolves.toBeNull();
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(1);
  });

  test("removeAnnotations 按 id 跨 tab 批量删除，未知 id 忽略", async () => {
    const { manager } = setup();
    await manager.attach(SESSION_A, 101);
    await manager.attach(SESSION_A, 102);
    const first = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "a",
    });
    const second = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#b",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "b",
    });
    const otherTab = await manager.addAnnotation(SESSION_A, 2, {
      selector: "#c",
      tag: "div",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "c",
    });

    await manager.removeAnnotations(SESSION_A, [first!.id, "missing"]);
    expect(manager.listAnnotations(SESSION_A, 1).map((annotation) => annotation.id)).toEqual([second!.id]);
    expect(manager.listAnnotations(SESSION_A, 2).map((annotation) => annotation.id)).toEqual([otherTab!.id]);

    await manager.removeAnnotations(SESSION_A, [second!.id, otherTab!.id]);
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);
    expect(manager.listAnnotations(SESSION_A, 2)).toHaveLength(0);

    // 空列表与其他会话安全。
    await expect(manager.removeAnnotations(SESSION_A, [])).resolves.toBeUndefined();
    await expect(manager.removeAnnotations(SESSION_B, [first!.id])).resolves.toBeUndefined();
    expect(manager.listAnnotations(SESSION_B, 1)).toHaveLength(0);
  });

  test("URL 真正切换时清理该 tab 标注（full 与 in-page），同 URL 事件不清理", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    const added = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "t",
    });
    expect(added).not.toBeNull();

    // 同 URL 重复 navigated 事件不清理。
    host.emit({ type: "navigated", url: "about:blank", canGoBack: false, canGoForward: false });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(1);

    // full navigation 到新 URL：清理。
    host.emit({ type: "navigated", url: "https://example.com/a", canGoBack: false, canGoForward: false });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);

    const hashAdded = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#b",
      tag: "div",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "h",
    });
    expect(hashAdded).not.toBeNull();
    // in-page URL 变化（hash）：清理。
    host.emit({ type: "navigated-in-page", url: "https://example.com/a#top" });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);

    const sameUrlAdded = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#c",
      tag: "div",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "s",
    });
    expect(sameUrlAdded).not.toBeNull();
    // 同 URL 重复 in-page 事件不清理。
    host.emit({ type: "navigated-in-page", url: "https://example.com/a#top" });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(1);

    // 其他 tab 的标注不受影响。
    await manager.attach(SESSION_A, 102);
    const otherTab = await manager.addAnnotation(SESSION_A, 2, {
      selector: "#d",
      tag: "div",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "o",
    });
    expect(otherTab).not.toBeNull();
    host.emit({ type: "navigated", url: "https://example.com/b", canGoBack: true, canGoForward: false });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);
    expect(manager.listAnnotations(SESSION_A, 2)).toHaveLength(1);
  });

  test("load-failed URL 变化时清理该 tab 标注；同 URL 重复失败不误删；重试成功不残留", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    const added = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "old",
    });
    expect(added).not.toBeNull();

    // 导航 B 首次失败：URL 已切换为 B，旧页面标注必须清理。
    host.emit({ type: "load-failed", url: "https://example.com/b", code: -105, description: "ERR_NAME_NOT_RESOLVED" });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);

    // 重试 B 成功：navigated 的 previousUrl 与 event.url 相同，不再触发清理；
    // 旧页面标注不会因首次失败而残留。
    host.emit({ type: "navigated", url: "https://example.com/b", canGoBack: false, canGoForward: false });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(0);

    // 同 URL 的重复 load-failed 不误删当前页标注。
    const onB = await manager.addAnnotation(SESSION_A, 1, {
      selector: "#b",
      tag: "div",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "on-b",
    });
    expect(onB).not.toBeNull();
    host.emit({ type: "load-failed", url: "https://example.com/b", code: -102, description: "ERR_CONNECTION_REFUSED" });
    expect(manager.listAnnotations(SESSION_A, 1)).toHaveLength(1);
  });

  test("加载失败广播 loadError，导航成功与开始加载时清除", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;

    host.emit({ type: "load-failed", url: "https://www.baidu.com/", code: -105, description: "ERR_NAME_NOT_RESOLVED" });
    expect(states.at(-1)?.tabs[0]).toMatchObject({
      url: "https://www.baidu.com/",
      title: "www.baidu.com",
      loading: false,
    });
    expect(states.at(-1)?.tabs[0]?.loadError).toEqual({
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
      url: "https://www.baidu.com/",
    });
    expect(states.at(-1)?.tabs[0]?.loading).toBe(false);

    host.emit({ type: "loading-changed", loading: true });
    expect(states.at(-1)?.tabs[0]?.loadError).toBeUndefined();

    host.emit({ type: "load-failed", url: "https://example.com/", code: -102, description: "ERR_CONNECTION_REFUSED" });
    expect(states.at(-1)?.tabs[0]?.loadError).toEqual({
      code: -102,
      description: "ERR_CONNECTION_REFUSED",
      url: "https://example.com/",
    });
    expect(states.at(-1)?.tabs[0]?.url).toBe("https://example.com/");
    expect(states.at(-1)?.tabs[0]?.title).toBe("example.com");
    host.emit({ type: "navigated", url: "https://example.com/", canGoBack: false, canGoForward: false });
    expect(states.at(-1)?.tabs[0]?.loadError).toBeUndefined();
  });
});

describe("BrowserManager 新能力透传（对齐 Codex browser_use）", () => {
  test("evaluate 透传到宿主并返回结果", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    host.evaluate = vi.fn(async () => ({ ok: true, value: "2", type: "number" }));

    const result = await manager.evaluate(SESSION_A, 1, "1 + 1");
    expect(result).toMatchObject({ ok: true, result: { ok: true, value: "2" } });
    expect(host.evaluate).toHaveBeenCalledWith("1 + 1");
  });

  test("pressKey 透传并激活 tab", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    host.pressKey = vi.fn(async () => undefined);

    const result = await manager.pressKey(SESSION_A, 1, "Control+Enter");
    expect(result).toEqual({ ok: true });
    expect(host.pressKey).toHaveBeenCalledWith("Control+Enter");
    expect(manager.activeTab(SESSION_A)?.tabId).toBe(1);
  });

  test("readConsoleLogs 透传 filter/levels/limit", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    host.readConsoleLogs = vi.fn(async () => [{ level: "log", message: "hello", timestamp: 1 }]);

    const result = await manager.readConsoleLogs(SESSION_A, 1, { filter: "hello", limit: 5 });
    expect(result.ok).toBe(true);
    expect(host.readConsoleLogs).toHaveBeenCalledWith({ filter: "hello", limit: 5 });
  });

  test("locatorAction 透传选择器/操作/参数", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    host.locatorAction = vi.fn(async () => ({ ok: true, count: 2 }));

    const result = await manager.locatorAction(SESSION_A, 1, "#btn", "count");
    expect(result).toMatchObject({ ok: true, count: 2 });
    expect(host.locatorAction).toHaveBeenCalledWith("#btn", "count", {});
  });

  test("downloadMedia 透传 url/savePath", async () => {
    const { manager, hosts } = setup();
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;
    host.downloadMedia = vi.fn(async () => undefined);

    const result = await manager.downloadMedia(SESSION_A, 1, "https://example.com/f.zip", "/tmp/f.zip");
    expect(result).toEqual({ ok: true });
    expect(host.downloadMedia).toHaveBeenCalledWith("https://example.com/f.zip", "/tmp/f.zip");
  });

  test("closeTab 广播 close 请求；未知 tab 报错", async () => {
    const requests: Array<{ sessionKey: string; tabId: number }> = [];
    const { manager } = setup({ onCloseTabRequest: (request) => requests.push(request) });
    await manager.attach(SESSION_A, 101);

    const result = await manager.closeTab(SESSION_A, 1);
    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([{ sessionKey: browserSessionKey(SESSION_A), tabId: 1 }]);

    const missing = await manager.closeTab(SESSION_A, 999);
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("不存在") });
  });
});

// ── 浏览器用户数据集成（历史持久化 / 网站设置覆盖 / 密码保存请求）────────

function makeDataService(dir: string): BrowserDataService {
  return new BrowserDataService(dir, {
    crypto: {
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(value, "utf8").reverse().toString("base64"),
      decrypt: (value) => Buffer.from(value, "base64").reverse().toString("utf8"),
    },
  });
}

describe("BrowserManager 用户数据", () => {
  test("导航记录持久化到数据服务；标题更新合并", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-data-mgr-${Date.now()}`);
    const data = makeDataService(dataDir);
    const { manager, hosts } = setup({ data });
    await manager.attach(SESSION_A, 101);
    const host = hosts.get(101)!;

    host.emit({ type: "navigated", url: "https://example.com/a", canGoBack: false, canGoForward: false });
    const snapshot = await data.getSnapshot();
    expect(snapshot.history.map((entry) => entry.url)).toEqual(["https://example.com/a"]);

    host.emit({ type: "navigated", url: "https://example.com/b", canGoBack: true, canGoForward: false });
    host.emit({ type: "title-updated", title: "B 页面" });
    expect((await data.getSnapshot()).history).toMatchObject([
      { url: "https://example.com/b", title: "B 页面" },
      { url: "https://example.com/a" },
    ]);

    host.emit({ type: "navigated", url: "https://example.com/a", canGoBack: true, canGoForward: false });
    expect((await data.getSnapshot()).history.map((entry) => entry.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/a",
    ]);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("自动填充读取凭据期间跨站导航时不向新页面注入", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-autofill-race-${Date.now()}`);
    const data = makeDataService(dataDir);
    let resolveSnapshot: ((value: Awaited<ReturnType<BrowserDataService["getSnapshot"]>>) => void) | undefined;
    vi.spyOn(data, "getSnapshot").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    let currentUrl = "https://example.com/login";
    let didFinishLoad: (() => void) | undefined;
    const guest = fakeWebContents(sessionFor(SESSION_A), { id: 42 } as WebContents, currentUrl);
    guest.getURL = () => currentUrl;
    guest.on = vi.fn((event: string, listener: () => void) => {
      if (event === "did-finish-load") didFinishLoad = listener;
      return guest;
    }) as WebContents["on"];
    const executeJavaScript = vi.fn(() => Promise.resolve(undefined));
    guest.executeJavaScript = executeJavaScript;
    const { manager } = setup({ data, fromWebContentsId: () => guest });
    await manager.attach(SESSION_A, 101);

    didFinishLoad?.();
    await vi.waitFor(() => expect(data.getSnapshot).toHaveBeenCalledOnce());
    currentUrl = "https://other.example/";
    resolveSnapshot?.({
      history: [],
      downloads: [],
      contacts: [],
      sitePermissions: [],
      passwords: [
        {
          id: "password-1",
          origin: "https://example.com",
          username: "alice",
          password: "s3cret",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain(BROWSER_PASSWORD_OFFER_BINDING);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("网站设置覆盖：非媒体权限 allow 放行、deny/无覆盖 fail-closed", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-data-mgr-${Date.now()}`);
    const data = makeDataService(dataDir);
    const { manager } = setup({ data });
    const browserSession = sessionFor(SESSION_A) as unknown as {
      setPermissionRequestHandler: { mock: { calls: unknown[][] } };
      setPermissionCheckHandler: { mock: { calls: unknown[][] } };
    };
    const requestHandler = browserSession.setPermissionRequestHandler.mock.calls.at(-1)?.[0] as (
      webContents: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl: string; securityOrigin?: string },
    ) => void;
    const checkHandler = browserSession.setPermissionCheckHandler.mock.calls.at(-1)?.[0] as (
      webContents: WebContents | null,
      permission: string,
      requestingOrigin: string,
    ) => boolean;

    // 无覆盖：fail-closed
    const denied: boolean[] = [];
    requestHandler({} as WebContents, "notifications", (granted) => denied.push(granted), {
      requestingUrl: "https://example.com/",
      securityOrigin: "https://example.com",
    });
    expect(denied).toEqual([false]);
    expect(checkHandler(null, "notifications", "https://example.com")).toBe(false);

    // 覆盖 allow：放行（含子域匹配）
    const allowed = await manager.browserSitePermissionSave({
      site: "example.com",
      kind: "notifications",
      value: "allow",
    });
    expect(allowed.ok).toBe(true);
    const allowedRequests: boolean[] = [];
    requestHandler({} as WebContents, "notifications", (granted) => allowedRequests.push(granted), {
      requestingUrl: "https://news.example.com/",
      securityOrigin: "https://news.example.com",
    });
    expect(allowedRequests).toEqual([true]);
    expect(checkHandler(null, "notifications", "https://news.example.com")).toBe(true);

    await manager.browserSitePermissionSave({
      site: "news.example.com",
      kind: "notifications",
      value: "deny",
    });
    expect(checkHandler(null, "notifications", "https://news.example.com")).toBe(false);
    // 其他站点不受影响
    expect(checkHandler(null, "notifications", "https://other.com")).toBe(false);

    // 覆盖 deny：拒绝
    const deniedSaved = await manager.browserSitePermissionSave({
      site: "other.com",
      kind: "notifications",
      value: "deny",
    });
    expect(deniedSaved.ok).toBe(true);
    const deniedRequests: boolean[] = [];
    requestHandler({} as WebContents, "notifications", (granted) => deniedRequests.push(granted), {
      requestingUrl: "https://other.com/",
      securityOrigin: "https://other.com",
    });
    expect(deniedRequests).toEqual([false]);
    expect(checkHandler(null, "notifications", "https://other.com")).toBe(false);

    // 删除覆盖后恢复 fail-closed
    const list = await data.listSitePermissions();
    const otherEntry = list.find((entry) => entry.site === "other.com");
    expect(otherEntry).toBeDefined();
    await manager.browserSitePermissionDelete(otherEntry!.id);
    expect(checkHandler(null, "notifications", "https://other.com")).toBe(false);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("媒体权限逐类型应用站点覆盖并回退到全局默认", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-media-${Date.now()}`);
    const data = makeDataService(dataDir);
    const { manager } = setup({ data });
    const browserSession = sessionFor(SESSION_A) as unknown as {
      setPermissionRequestHandler: { mock: { calls: unknown[][] } };
    };
    const requestHandler = browserSession.setPermissionRequestHandler.mock.calls.at(-1)?.[0] as (
      webContents: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details: { requestingUrl: string; securityOrigin?: string; mediaTypes?: Array<"video" | "audio"> },
    ) => void;
    const initial = await manager.getSettingsSnapshot();
    await manager.saveSettings({
      expectedRevision: initial.revision,
      settings: { ...initial.settings, mediaDefault: "allow" },
    });
    await manager.browserSitePermissionSave({ site: "example.com", kind: "camera", value: "allow" });

    const results: boolean[] = [];
    requestHandler({} as WebContents, "media", (granted) => results.push(granted), {
      requestingUrl: "https://example.com/",
      securityOrigin: "https://example.com",
      mediaTypes: ["video", "audio"],
    });
    expect(results).toEqual([true]);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("冷启动网站设置未加载时权限 fail-closed，加载后恢复全局 fallback", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-permission-ready-${Date.now()}`);
    const data = makeDataService(dataDir);
    let resolvePermissions:
      | ((value: Awaited<ReturnType<BrowserDataService["listSitePermissions"]>>) => void)
      | undefined;
    vi.spyOn(data, "listSitePermissions").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePermissions = resolve;
        }),
    );
    const { manager } = setup({ data });
    const browserSession = sessionFor(SESSION_A) as unknown as {
      setPermissionCheckHandler: { mock: { calls: unknown[][] } };
    };
    const checkHandler = browserSession.setPermissionCheckHandler.mock.calls.at(-1)?.[0] as (
      webContents: WebContents | null,
      permission: string,
      requestingOrigin: string,
      details: { mediaType?: "video" | "audio" },
    ) => boolean;
    const initial = await manager.getSettingsSnapshot();
    await manager.saveSettings({
      expectedRevision: initial.revision,
      settings: { ...initial.settings, mediaDefault: "allow" },
    });

    expect(checkHandler(null, "media", "https://other.com", { mediaType: "video" })).toBe(false);
    resolvePermissions?.([
      {
        id: "deny-camera",
        site: "blocked.example.com",
        kind: "camera",
        value: "deny",
        updatedAt: 1,
      },
    ]);
    await vi.waitFor(() => {
      expect(checkHandler(null, "media", "https://other.com", { mediaType: "video" })).toBe(true);
    });
    expect(checkHandler(null, "media", "https://blocked.example.com", { mediaType: "video" })).toBe(false);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("默认下载目录下仍记录完成状态", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-download-${Date.now()}`);
    const data = makeDataService(dataDir);
    setup({ data });
    const browserSession = sessionFor(SESSION_A) as unknown as { on: { mock: { calls: unknown[][] } } };
    const onWillDownload = browserSession.on.mock.calls.filter(([name]) => name === "will-download").at(-1)?.[1] as (
      event: Electron.Event,
      item: Electron.DownloadItem,
    ) => void;
    let onDone: ((event: Electron.Event, state: "completed") => void) | undefined;
    const setSavePath = vi.fn();
    const item = {
      getFilename: () => "file.zip",
      getURL: () => "https://example.com/file.zip",
      getSavePath: () => "/system/Downloads/file.zip",
      getTotalBytes: () => 100,
      getReceivedBytes: () => 100,
      setSavePath,
      once: (_event: string, listener: typeof onDone) => {
        onDone = listener;
      },
    } as unknown as Electron.DownloadItem;

    onWillDownload({} as Electron.Event, item);
    expect(setSavePath).not.toHaveBeenCalled();
    onDone?.({} as Electron.Event, "completed");
    expect((await data.getSnapshot()).downloads).toMatchObject([
      { filename: "file.zip", path: "/system/Downloads/file.zip", state: "completed" },
    ]);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("浏览器数据通道：密码保存/删除与未知 offer 返回失败", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-data-mgr-${Date.now()}`);
    const data = makeDataService(dataDir);
    const offers: Array<{ origin: string; username: string }> = [];
    const { manager } = setup({
      data,
      onPasswordOffer: (offer) => offers.push({ origin: offer.origin, username: offer.username }),
    });

    // 未知/过期 offer：resolve 返回失败且不产生副作用
    await expect(manager.browserPasswordOfferResolve(SESSION_A, "unknown-offer", true, 9_001)).resolves.toMatchObject({
      ok: false,
    });
    expect((await data.getSnapshot()).passwords).toHaveLength(0);

    const saved = await manager.browserPasswordSave({
      passwordId: null,
      password: { origin: "https://example.com", username: "alice", password: "s3cret" },
    });
    expect(saved.ok).toBe(true);
    expect((await manager.browserDataGet()).passwords).toHaveLength(0);
    const snapshot = await manager.browserDataGet(true);
    expect(snapshot.passwords).toHaveLength(1);
    expect(snapshot.passwords[0]).toMatchObject({ origin: "https://example.com", username: "alice" });

    const deleted = await manager.browserPasswordDelete(snapshot.passwords[0].id);
    expect(deleted.ok).toBe(true);
    expect(await manager.browserDataGet()).toMatchObject({ passwords: [] });
    expect(offers).toHaveLength(0);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("密码 offer 不含正文、绑定当前 origin 且只能由所属会话保存", async () => {
    const dataDir = join(tmpdir(), `desktop-browser-offer-${Date.now()}`);
    const data = makeDataService(dataDir);
    const offers: Array<{
      offer: Parameters<NonNullable<BrowserManagerOptions["onPasswordOffer"]>>[0];
      ownerId: number;
    }> = [];
    const { manager, hostOptions } = setup({
      data,
      onPasswordOffer: (offer, ownerId) => offers.push({ offer, ownerId }),
      fromWebContentsId: () =>
        fakeWebContents(sessionFor(SESSION_A), { id: 42 } as WebContents, "https://example.com/login"),
    });
    await manager.attach(SESSION_A, 101);

    hostOptions
      .get(101)
      ?.onRuntimeBinding?.(
        BROWSER_PASSWORD_OFFER_BINDING,
        JSON.stringify({ url: "https://other.example/login", username: "mallory", password: "wrong" }),
      );
    expect(offers).toHaveLength(0);

    hostOptions
      .get(101)
      ?.onRuntimeBinding?.(
        BROWSER_PASSWORD_OFFER_BINDING,
        JSON.stringify({ url: "https://example.com/login", username: "alice", password: "s3cret" }),
      );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      ownerId: 42,
      offer: { origin: "https://example.com", username: "alice", identity: SESSION_A },
    });
    expect(offers[0]!.offer).not.toHaveProperty("password");

    const offerId = offers[0]!.offer.id;
    await expect(manager.browserPasswordOfferResolve(SESSION_B, offerId, true, 42)).resolves.toMatchObject({
      ok: false,
    });
    await expect(manager.browserPasswordOfferResolve(SESSION_A, offerId, true, 99)).resolves.toMatchObject({
      ok: false,
    });
    await expect(manager.browserPasswordOfferResolve(SESSION_A, offerId, true, 42)).resolves.toEqual({ ok: true });
    expect((await data.getSnapshot()).passwords).toMatchObject([
      { origin: "https://example.com", username: "alice", password: "s3cret" },
    ]);
    await rm(dataDir, { recursive: true, force: true });
  });
});
