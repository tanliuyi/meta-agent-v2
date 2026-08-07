import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";
import type {
  BrowserHostController,
  BrowserHostEvent,
  PickElementResult,
} from "../src/main/browser/browser-host-controller.ts";
import { StaleReferenceError } from "../src/main/browser/browser-host-controller.ts";
import { BrowserManager, type BrowserManagerOptions } from "../src/main/browser/browser-manager.ts";
import type {
  BrowserAction,
  BrowserAnnotationBounds,
  BrowserCreateTabRequest,
  BrowserSnapshot,
  BrowserStateEvent,
} from "../src/shared/browser-contracts.ts";

const electron = vi.hoisted(() => {
  const clearStorageData = vi.fn().mockResolvedValue(undefined);
  const clearCache = vi.fn().mockResolvedValue(undefined);
  const browserSession = {
    setPermissionRequestHandler: vi.fn(),
    clearStorageData,
    clearCache,
    on: vi.fn(),
    off: vi.fn(),
  };
  return { browserSession, clearStorageData, clearCache };
});

vi.mock("electron", () => ({
  webContents: { fromId: () => null },
  session: {
    fromPartition: () => electron.browserSession,
  },
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

  dispose(): void {
    this.disposed = true;
  }
}

interface Setup {
  manager: BrowserManager;
  hosts: Map<number, FakeHost>;
  hostOptions: Map<number, { cdpTimeoutMs?: number; maxSnapshotNodes?: number }>;
  states: BrowserStateEvent[];
}

function fakeWebContents(
  contentsSession = electron.browserSession,
  hostWebContents: WebContents | null = {} as WebContents,
  url = "about:blank",
): WebContents {
  return {
    session: contentsSession,
    hostWebContents,
    getURL: () => url,
    getTitle: () => "",
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  } as unknown as WebContents;
}

function setup(options: Partial<BrowserManagerOptions> = {}): Setup {
  const hosts = new Map<number, FakeHost>();
  const hostOptions = new Map<number, { cdpTimeoutMs?: number; maxSnapshotNodes?: number }>();
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
    fromWebContentsId: options.fromWebContentsId ?? (() => fakeWebContents()),
  });
  return { manager, hosts, hostOptions, states };
}

describe("BrowserManager", () => {
  test("attach 注册 tab 并广播状态", async () => {
    const { manager, hosts, states } = setup();

    const result = await manager.attach(101);

    expect(result).toMatchObject({ ok: true, tab: { tabId: 1, url: "about:blank" } });
    expect(hosts.has(101)).toBe(true);
    expect(manager.tabsList()).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ activeTabId: 1, tabs: [{ tabId: 1 }] });
  });

  test("同一 webContentsId 重复 attach 幂等返回同一 tab", async () => {
    const { manager, hosts } = setup();

    const first = await manager.attach(101);
    const second = await manager.attach(101);

    expect(second).toMatchObject({ ok: true, tab: { tabId: first.ok === true ? first.tab.tabId : -1 } });
    expect(hosts.size).toBe(1);
    expect(manager.tabsList()).toHaveLength(1);
  });

  test("webContents 不存在时 attach 返回错误", async () => {
    const manager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      fromWebContentsId: () => null,
    });

    const result = await manager.attach(999);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("不存在") });
  });

  test("webContents 不属于浏览器分区或不是 guest 时 attach 被拒绝", async () => {
    const foreignSession = {} as Electron.Session;
    const foreignManager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      fromWebContentsId: () => fakeWebContents(foreignSession),
    });
    await expect(foreignManager.attach(999)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("分区"),
    });

    const nonGuestManager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      fromWebContentsId: () => fakeWebContents(electron.browserSession, null),
    });
    await expect(nonGuestManager.attach(998)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("guest"),
    });
  });

  test("navigate 拒绝非法协议与非法 URL", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);

    await expect(manager.navigate(1, "file:///etc/passwd")).resolves.toMatchObject({ ok: false });
    await expect(manager.navigate(1, "ftp://example.com")).resolves.toMatchObject({ ok: false });
    await expect(manager.navigate(1, "not a url")).resolves.toMatchObject({ ok: false });
    expect(hosts.get(101)?.navigatedUrls).toEqual([]);
  });

  test("navigate 成功转发到宿主并规范化 URL", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);

    const result = await manager.navigate(1, "https://example.com");

    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.navigatedUrls).toEqual(["https://example.com/"]);
  });

  test("navigate 不存在的 tab 返回错误", async () => {
    const { manager } = setup();

    await expect(manager.navigate(42, "https://example.com")).resolves.toMatchObject({ ok: false });
  });

  test("宿主事件更新 tab 状态并广播", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(101);
    const host = hosts.get(101)!;

    host.emit({ type: "navigated", url: "https://example.com/page", canGoBack: true, canGoForward: false });
    expect(manager.tabsList()[0]).toMatchObject({ url: "https://example.com/page", canGoBack: true });

    host.emit({ type: "title-updated", title: "Example" });
    expect(manager.tabsList()[0]?.title).toBe("Example");

    host.emit({ type: "loading-changed", loading: true });
    expect(manager.tabsList()[0]?.loading).toBe(true);

    host.emit({ type: "navigated-in-page", url: "https://example.com/page#top" });
    expect(manager.tabsList()[0]?.url).toBe("https://example.com/page#top");

    host.emit({ type: "crashed", reason: "crashed" });
    expect(manager.tabsList()[0]).toMatchObject({ crashed: true, loading: false });

    expect(states).toHaveLength(1 + 5);
  });

  test("screenshot 成功返回 dataUrl", async () => {
    const { manager } = setup();
    await manager.attach(101);

    const result = await manager.screenshot(1);

    expect(result).toMatchObject({ ok: true, dataUrl: "data:image/png;base64,AAAA", width: 100, height: 80 });
  });

  test("screenshot 对崩溃或未知 tab 返回错误", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);
    hosts.get(101)!.emit({ type: "crashed", reason: "crashed" });

    await expect(manager.screenshot(1)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("崩溃") });
    await expect(manager.screenshot(42)).resolves.toMatchObject({ ok: false });
  });

  test("detach 移除 tab、释放宿主并广播；幂等", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(101);
    const host = hosts.get(101)!;

    await manager.detach(101);
    await manager.detach(101);

    expect(manager.tabsList()).toHaveLength(0);
    expect(host.disposed).toBe(true);
    expect(states.at(-1)).toMatchObject({ activeTabId: null, tabs: [] });
  });

  test("selectTab 切换活跃 tab；未知 tab 返回 null", async () => {
    const { manager, states } = setup();
    await manager.attach(101);
    await manager.attach(102);

    const selected = manager.selectTab(1);
    expect(selected?.tabId).toBe(1);
    expect(states.at(-1)?.activeTabId).toBe(1);
    expect(manager.selectTab(42)).toBeNull();
  });

  test("关闭活跃 tab 后活跃回退到剩余第一个 tab", async () => {
    const { manager, states } = setup();
    await manager.attach(101); // tab 1（active）
    await manager.attach(102); // tab 2（active）

    await manager.detach(102);

    expect(states.at(-1)?.activeTabId).toBe(1);
    expect(manager.tabsList().map((tab) => tab.tabId)).toEqual([1]);
  });

  test("clearData 直接清除持久浏览器分区，即使没有已注册宿主", async () => {
    const { manager, hosts } = setup();

    await manager.clearData();

    expect(electron.clearStorageData).toHaveBeenCalled();
    expect(electron.clearCache).toHaveBeenCalled();
    expect(hosts.size).toBe(0);
  });

  test("dispose 释放全部宿主且不再广播", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(101);
    const host = hosts.get(101)!;
    states.length = 0;

    manager.dispose();

    expect(host.disposed).toBe(true);
    expect(manager.tabsList()).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  test("设置快照与保存透传到设置服务", async () => {
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

  test("attach 使用运行时 CDP 设置，保存后更新既有宿主", async () => {
    const { manager, hosts, hostOptions } = setup();
    const initial = await manager.getSettingsSnapshot();
    const saved = await manager.saveSettings({
      expectedRevision: initial.revision,
      settings: { ...initial.settings, maxSnapshotNodes: 321, cdpTimeoutMs: 2_000 },
    });
    expect(saved.status).toBe("saved");

    await manager.attach(101);
    expect(hostOptions.get(101)).toMatchObject({ maxSnapshotNodes: 321, cdpTimeoutMs: 2_000 });

    if (saved.status !== "saved") throw new Error("settings save failed");
    const updated = await manager.saveSettings({
      expectedRevision: saved.snapshot.revision,
      settings: { ...saved.snapshot.settings, maxSnapshotNodes: 444, cdpTimeoutMs: 3_000 },
    });
    expect(updated.status).toBe("saved");
    expect(hosts.get(101)?.updatedSettings.at(-1)).toEqual({ maxSnapshotNodes: 444, cdpTimeoutMs: 3_000 });
  });
  test("destroyed 事件移除 tab 并释放宿主，活跃回退", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(101);
    await manager.attach(102);
    manager.selectTab(1);
    const host1 = hosts.get(101)!;
    const host2 = hosts.get(102)!;

    host2.emit({ type: "destroyed" });

    expect(manager.tabsList().map((tab) => tab.tabId)).toEqual([1]);
    expect(host2.disposed).toBe(true);
    expect(states.at(-1)?.activeTabId).toBe(1);

    host1.emit({ type: "destroyed" });
    expect(manager.tabsList()).toHaveLength(0);
    expect(states.at(-1)?.activeTabId).toBeNull();
    expect(host1.disposed).toBe(true);
  });

  test("activeTab 返回当前活跃 tab；无 tab 返回 null", async () => {
    const { manager } = setup();
    expect(manager.activeTab()).toBeNull();

    await manager.attach(101);
    expect(manager.activeTab()).toMatchObject({ tabId: 1 });

    manager.selectTab(1);
    expect(manager.activeTab()?.tabId).toBe(1);
  });

  test("openTab 广播建 tab 请求并在 renderer attach 后完成并导航", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager, hosts } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    const openPromise = manager.openTab("https://example.com");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://example.com/" });
    const requestId = requests[0]!.requestId;

    const attachResult = await manager.attach(101, requestId);
    expect(attachResult.ok).toBe(true);

    const result = await openPromise;
    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.navigatedUrls).toEqual(["https://example.com/"]);
  });

  test("openTab attach 后导航失败时返回失败且清理 tab", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const host = new FakeHost();
    host.navigationError = new Error("导航失败");
    const manager = new BrowserManager(join(tmpdir(), `desktop-browser-manager-${Date.now()}`), {
      onCreateTabRequest: (request) => requests.push(request),
      createHost: () => host,
      fromWebContentsId: () => fakeWebContents(),
    });

    const pending = manager.openTab("https://example.com");
    const requestId = requests[0]!.requestId;
    const attach = await manager.attach(101, requestId);

    expect(attach).toMatchObject({ ok: false, error: "导航失败" });
    await expect(pending).resolves.toMatchObject({ ok: false, error: "导航失败" });
    expect(manager.tabsList()).toHaveLength(0);
  });
  test("openTab 拒绝非法 URL", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    await expect(manager.openTab("file:///etc/passwd")).resolves.toMatchObject({ ok: false });
    expect(requests).toHaveLength(0);
  });

  test("openTab 无协议输入补 https://", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ onCreateTabRequest: (request) => requests.push(request) });

    const pending = manager.openTab("example.com/foo");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://example.com/foo" });
    // 模拟 renderer attach 完成请求。
    requests[0]?.requestId;
    const requestId = requests[0]!.requestId;
    await manager.attach(101, requestId);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  test("openTab 超时返回错误", async () => {
    const { manager } = setup({ openTabTimeoutMs: 30 });

    await expect(manager.openTab("https://example.com")).resolves.toMatchObject({
      ok: false,
      error: "创建浏览器标签页超时（30ms）",
    });
  });

  test("openTab 超时后迟到 attach 被拒绝且不会留下孤儿 tab", async () => {
    const requests: BrowserCreateTabRequest[] = [];
    const { manager } = setup({ openTabTimeoutMs: 10, onCreateTabRequest: (request) => requests.push(request) });

    await expect(manager.openTab("https://example.com")).resolves.toMatchObject({ ok: false });
    const lateAttach = await manager.attach(101, requests[0]!.requestId);

    expect(lateAttach).toMatchObject({ ok: false, error: expect.stringContaining("已超时") });
    expect(manager.tabsList()).toHaveLength(0);
  });

  test("navigationTarget 返回准确的 back/forward 目标", async () => {
    const { manager } = setup();
    await manager.attach(101);

    expect(manager.navigationTarget(1, "back")).toMatchObject({
      ok: true,
      target: { url: "https://example.com/previous" },
    });
    expect(manager.navigationTarget(1, "forward")).toMatchObject({
      ok: true,
      target: { url: "https://example.com/next" },
    });
  });

  test("snapshot 透传到宿主", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);

    const result = await manager.snapshot(1, { withScreenshot: true });

    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.snapshotCalls).toEqual([{ withScreenshot: true }]);
    expect(hosts.get(101)?.snapshotCalls[0]).toEqual({ withScreenshot: true });
  });

  test("snapshot 对未知 tab 或崩溃 tab 返回错误", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);
    hosts.get(101)!.emit({ type: "crashed", reason: "crashed" });

    await expect(manager.snapshot(1)).resolves.toMatchObject({ ok: false });
    await expect(manager.snapshot(42)).resolves.toMatchObject({ ok: false });
  });

  test("action 透传到宿主", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);
    const action: BrowserAction = { type: "type", elementIndex: 2, text: "hello", submit: true };

    const result = await manager.action(1, action);

    expect(result.ok).toBe(true);
    expect(hosts.get(101)?.performedActions).toEqual([action]);
  });

  test("goBack/goForward/reload 透传到宿主", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);

    await expect(manager.goBack(1)).resolves.toMatchObject({ ok: true });
    await expect(manager.goForward(1)).resolves.toMatchObject({ ok: true });
    await expect(manager.reload(1)).resolves.toMatchObject({ ok: true });
    const host = hosts.get(101)!;
    expect(host.backCount).toBe(1);
    expect(host.forwardCount).toBe(1);
    expect(host.reloadCount).toBe(1);

    await expect(manager.goBack(42)).resolves.toMatchObject({ ok: false });
  });

  test("action 的 stale ref 错误映射为 staleRef 标记", async () => {
    const { manager } = setup();
    await manager.attach(101);

    const result = await manager.action(1, { type: "click", elementIndex: 999 });

    expect(result).toMatchObject({ ok: false, staleRef: true });
  });

  test("访问历史：导航记录、同 URL 合并、tab 关闭清理", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);
    const host = hosts.get(101)!;

    host.emit({ type: "navigated", url: "https://example.com/a", canGoBack: false, canGoForward: false });
    host.emit({ type: "title-updated", title: "A 页面" });
    host.emit({ type: "navigated", url: "https://example.com/b", canGoBack: true, canGoForward: false });
    // 同一 tab 重复导航同 URL：不重复记录。
    host.emit({ type: "navigated", url: "https://example.com/b", canGoBack: true, canGoForward: false });

    expect(manager.browserHistory()).toHaveLength(2);
    expect(manager.browserHistory()[0]).toMatchObject({ url: "https://example.com/b" });
    expect(manager.browserHistory()[1]).toMatchObject({ url: "https://example.com/a", title: "A 页面" });

    // 第二个 tab 导航到同一 URL：合并并提前。
    await manager.attach(102);
    const host2 = hosts.get(102)!;
    host2.emit({ type: "navigated", url: "https://example.com/a", canGoBack: false, canGoForward: false });
    expect(manager.browserHistory()).toHaveLength(2);
    expect(manager.browserHistory()[0]).toMatchObject({ url: "https://example.com/a" });

    // 关闭 tab 不影响全局历史。
    await manager.detach(101);
    expect(manager.browserHistory()).toHaveLength(2);
  });

  test("标注：pick/add/list/remove/resolve 全链路", async () => {
    const { manager } = setup();
    await manager.attach(101);

    const pick = await manager.pickAnnotationTarget(1, 30, 40);
    expect(pick).toMatchObject({ ok: true, selector: "#fake-30-40", bounds: { x: 30, y: 40 } });

    const added = await manager.addAnnotation(1, {
      selector: "#fake-30-40",
      tag: "button",
      bounds: { x: 30, y: 40, width: 10, height: 10 },
      text: "按钮文案要改",
    });
    expect(added).toMatchObject({ selector: "#fake-30-40", tag: "button", text: "按钮文案要改" });
    expect(typeof added?.id).toBe("string");

    expect(manager.listAnnotations(1)).toHaveLength(1);
    await expect(manager.resolveAnnotationBounds(1, added!.id)).resolves.toEqual({ x: 1, y: 2, width: 10, height: 10 });

    await manager.removeAnnotation(1, added!.id);
    expect(manager.listAnnotations(1)).toHaveLength(0);

    // tab 不存在时 pick 报错、add 返回 null。
    await expect(manager.pickAnnotationTarget(42, 1, 1)).resolves.toMatchObject({ ok: false });
    await expect(
      manager.addAnnotation(42, { selector: "#x", tag: "div", bounds: { x: 0, y: 0, width: 1, height: 1 }, text: "x" }),
    ).resolves.toBeNull();
  });

  test("标注随 tab 关闭清理", async () => {
    const { manager, hosts } = setup();
    await manager.attach(101);
    await manager.addAnnotation(1, {
      selector: "#a",
      tag: "button",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      text: "t",
    });
    expect(manager.listAnnotations(1)).toHaveLength(1);

    await manager.detach(101);
    expect(manager.listAnnotations(1)).toHaveLength(0);
    expect(hosts.get(101)?.disposed).toBe(true);
  });

  test("加载失败广播 loadError，导航成功与开始加载时清除", async () => {
    const { manager, hosts, states } = setup();
    await manager.attach(101);
    const host = hosts.get(101)!;

    host.emit({ type: "load-failed", url: "https://www.baidu.com/", code: -105, description: "ERR_NAME_NOT_RESOLVED" });
    expect(states.at(-1)?.tabs[0]?.loadError).toContain("域名解析失败（DNS）");
    expect(hosts.get(101) && states.at(-1)?.tabs[0]?.loading).toBe(false);

    // 开始新加载：错误清除。
    host.emit({ type: "loading-changed", loading: true });
    expect(states.at(-1)?.tabs[0]?.loadError).toBeUndefined();

    // 加载失败后导航成功：错误清除。
    host.emit({ type: "load-failed", url: "https://example.com/", code: -106, description: "ERR_CONNECTION_REFUSED" });
    expect(states.at(-1)?.tabs[0]?.loadError).toContain("无法连接服务器");
    host.emit({ type: "navigated", url: "https://example.com/", canGoBack: false, canGoForward: false });
    expect(states.at(-1)?.tabs[0]?.loadError).toBeUndefined();
  });
});
