import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BrowserClient, BrowserUnavailableError } from "../src/main/pi/extensions/pi-browser/lib/browser-client.ts";
import {
  cleanupOldSpills,
  MAX_SNAPSHOT_TEXT,
  MAX_SPILL_FILES,
  SPILL_FILE_PREFIX,
  spillSnapshotText,
} from "../src/main/pi/extensions/pi-browser/lib/render-snapshot.ts";
import { SiteAccessController } from "../src/main/pi/extensions/pi-browser/lib/site-access.ts";
import { registerBrowserTools } from "../src/main/pi/extensions/pi-browser/register-tools.ts";
import type { BrowserSnapshot, BrowserSnapshotResult, BrowserTab } from "../src/shared/browser-contracts.ts";
import { type BrowserSettingsSnapshot, defaultBrowserSettings } from "../src/shared/browser-settings-contracts.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Record<string, any>;

function createFakePi(): { pi: ExtensionAPI; tools: AnyTool[] } {
  const tools: AnyTool[] = [];
  const pi = {
    registerTool: (tool: AnyTool) => tools.push(tool),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

function createFakeClient(): {
  client: BrowserClient;
  calls: {
    tabsList: ReturnType<typeof vi.fn>;
    activeTab: ReturnType<typeof vi.fn>;
    browserHistory: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
    historyTarget: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    inspectElement: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
    openTab: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    tabsList: vi.fn(),
    activeTab: vi.fn(),
    browserHistory: vi.fn(),
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    historyTarget: vi.fn(),
    reload: vi.fn(),
    snapshot: vi.fn(),
    inspectElement: vi.fn(),
    action: vi.fn(),
    openTab: vi.fn(),
    screenshot: vi.fn(),
    getSettings: vi.fn(),
  };
  return { client: calls as unknown as BrowserClient, calls };
}

const SNAPSHOT: BrowserSnapshot = {
  url: "https://example.com/",
  title: "Example",
  timestamp: 1,
  viewport: { width: 800, height: 600, dpr: 1 },
  tree: [
    {
      role: "navigation",
      name: "site",
      tag: "nav",
      children: [{ index: 1, role: "link", name: "Home", tag: "a", attrs: { href: "/" } }],
    },
    { index: 2, role: "button", name: "Sign in", tag: "button" },
  ],
  screenshot: null,
};

const TAB: BrowserTab = {
  tabId: 5,
  url: "https://example.com/",
  title: "Example",
  loading: false,
  crashed: false,
  canGoBack: false,
  canGoForward: false,
  createdAt: 1,
};

const ACTION_SNAPSHOT: BrowserSnapshot = {
  ...SNAPSHOT,
  tree: [
    ...SNAPSHOT.tree,
    { index: 4, role: "textbox", name: "Input", tag: "input" },
    { index: 9, role: "generic", name: "Target", tag: "div" },
  ],
};

/** 默认设置快照：example.com 在允许列表，其余未列入。 */
const DEFAULT_SETTINGS: BrowserSettingsSnapshot = {
  path: "/tmp/browser-settings.json",
  exists: true,
  revision: "rev-1",
  settings: {
    ...defaultBrowserSettings(),
    allowSites: ["example.com"],
  },
};

/** 造一个必会溢出的超大快照树。 */
function buildHugeSnapshot(): BrowserSnapshot {
  return {
    ...SNAPSHOT,
    tree: Array.from({ length: 120 }, (_, i) => ({
      index: i + 1,
      role: "link",
      name: `A link with a rather long accessible name for row number ${i}`,
      tag: "a",
    })),
  };
}

describe("BrowserClient", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.PORT = process.env.PI_BROWSER_HOST_PORT;
    envBackup.TOKEN = process.env.PI_BROWSER_TOKEN;
    envBackup.SESSION_TOKEN = process.env.PI_BROWSER_SESSION_TOKEN;
    envBackup.PROJECT = process.env.PI_BROWSER_SESSION_PROJECT_ID;
    process.env.PI_BROWSER_SESSION_TOKEN = "session-tok";
    envBackup.THREAD = process.env.PI_BROWSER_SESSION_THREAD_ID;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("env 缺失时构造抛 BrowserUnavailableError", () => {
    delete process.env.PI_BROWSER_HOST_PORT;
    delete process.env.PI_BROWSER_TOKEN;
    delete process.env.PI_BROWSER_SESSION_PROJECT_ID;
    delete process.env.PI_BROWSER_SESSION_THREAD_ID;
    expect(() => new BrowserClient()).toThrow(BrowserUnavailableError);
  });

  test("会话身份 env 缺失时构造抛 BrowserUnavailableError（fail-closed）", () => {
    process.env.PI_BROWSER_HOST_PORT = "8123";
    process.env.PI_BROWSER_TOKEN = "tok";
    delete process.env.PI_BROWSER_SESSION_PROJECT_ID;
    delete process.env.PI_BROWSER_SESSION_THREAD_ID;
    expect(() => new BrowserClient()).toThrow("PI_BROWSER_SESSION");
  });

  test("成功信封解析并返回 data；每个请求携带会话身份头", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, data: [{ tabId: 1 }] }), { status: 200 }));
    const client = new BrowserClient({
      port: 8123,
      token: "tok",
      sessionProjectId: "proj-a",
      sessionThreadId: "thread-a",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.tabsList();
    expect(result).toEqual([{ tabId: 1 }]);
    const request = fetchImpl.mock.calls[0] as unknown[];
    expect(request[0]).toBe("http://127.0.0.1:8123/rpc");
    const init = request[1] as { headers: Record<string, string>; body: string };
    expect(init.headers["x-desktop-browser-token"]).toBe("tok");
    expect(init.headers["x-desktop-browser-session-token"]).toBe("session-tok");
    expect(init.headers["x-desktop-browser-session-project-id"]).toBe("proj-a");
    expect(init.headers["x-desktop-browser-session-thread-id"]).toBe("thread-a");
    expect(JSON.parse(init.body)).toEqual({ method: "tabsList", params: undefined });
  });

  test("env 注入的会话身份随请求发送", async () => {
    process.env.PI_BROWSER_SESSION_PROJECT_ID = "env-proj";
    process.env.PI_BROWSER_SESSION_THREAD_ID = "env-thread";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, data: null }), { status: 200 }));
    const client = new BrowserClient({
      port: 8123,
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.activeTab();
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(init.headers["x-desktop-browser-session-project-id"]).toBe("env-proj");
    expect(init.headers["x-desktop-browser-session-thread-id"]).toBe("env-thread");
  });

  test("信封失败抛普通错误（保留 server 错误文案）", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "tab 1 不存在" }), { status: 200 }));
    const client = new BrowserClient({
      port: 8123,
      token: "tok",
      sessionProjectId: "proj-a",
      sessionThreadId: "thread-a",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.navigate(1, "https://example.com/")).rejects.toThrow("tab 1 不存在");
  });

  test("HTTP 错误与网络异常统一为 BrowserUnavailableError", async () => {
    const httpError = new BrowserClient({
      port: 8123,
      token: "tok",
      sessionProjectId: "proj-a",
      sessionThreadId: "thread-a",
      fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(httpError.activeTab()).rejects.toThrow(BrowserUnavailableError);

    const networkError = new BrowserClient({
      port: 8123,
      token: "tok",
      sessionProjectId: "proj-a",
      sessionThreadId: "thread-a",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(networkError.activeTab()).rejects.toThrow(BrowserUnavailableError);
  });

  test("HTTP 5xx 时透传服务端错误文案（openTab 超时）", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "创建浏览器标签页超时（15000ms）" }), { status: 500 }),
      );
    const client = new BrowserClient({
      port: 8123,
      token: "tok",
      sessionProjectId: "proj-a",
      sessionThreadId: "thread-a",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.openTab("https://example.com/")).rejects.toThrow("创建浏览器标签页超时（15000ms）");
  });
});

describe("renderSnapshotText / spill", () => {
  test("文本渲染含编号、层级与属性摘要", async () => {
    const { text, spilledPath } = await spillSnapshotText(SNAPSHOT);
    expect(spilledPath).toBeNull();
    expect(text).toContain("navigation site");
    expect(text).toContain("  [1] link Home (href=/)");
    expect(text).toContain("[2] button Sign in");
  });

  test("超限时写 spill 文件并截断", async () => {
    const { text, spilledPath } = await spillSnapshotText(buildHugeSnapshot());
    expect(spilledPath).not.toBeNull();
    expect(text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT + 200);
    expect(existsSync(spilledPath!)).toBe(true);
    expect(readFileSync(spilledPath!, "utf8").length).toBeGreaterThan(MAX_SNAPSHOT_TEXT);
    rmSync(spilledPath!, { force: true });
  });

  test("cleanupOldSpills 删除过期文件与超量最旧文件，保留其他文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-browser-spill-test-"));
    try {
      const now = Date.now();
      const fresh = join(dir, `${SPILL_FILE_PREFIX}${now}-fresh.txt`);
      const old = join(dir, `${SPILL_FILE_PREFIX}${now - 48 * 60 * 60 * 1000}-old.txt`);
      const unrelated = join(dir, "other-file.txt");
      writeFileSync(fresh, "x");
      writeFileSync(old, "x");
      writeFileSync(unrelated, "x");
      // 把 mtime 调成过去时间（old 超过 24h）。
      utimesSync(fresh, new Date(now - 1000), new Date(now - 1000));
      utimesSync(old, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));

      const removed = await cleanupOldSpills(dir);
      expect(removed).toBe(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleanupOldSpills 超过上限时删除最旧文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-browser-spill-test-"));
    try {
      const now = Date.now();
      const paths: string[] = [];
      for (let index = 0; index < MAX_SPILL_FILES + 5; index += 1) {
        const path = join(dir, `${SPILL_FILE_PREFIX}${now - index * 1000}-${index}.txt`);
        writeFileSync(path, "x");
        utimesSync(path, new Date(now - index * 1000), new Date(now - index * 1000));
        paths.push(path);
      }

      const removed = await cleanupOldSpills(dir);
      expect(removed).toBe(5);
      // index 越大 mtime 越旧：最旧的 5 个被删除，其余保留。
      for (let index = MAX_SPILL_FILES; index < paths.length; index += 1) {
        expect(existsSync(paths[index])).toBe(false);
      }
      for (let index = 0; index < MAX_SPILL_FILES; index += 1) {
        expect(existsSync(paths[index])).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pi-browser 工具注册", () => {
  const { pi, tools } = createFakePi();
  const { client, calls } = createFakeClient();
  const siteAccess = new SiteAccessController();

  beforeEach(() => {
    calls.tabsList.mockReset();
    calls.tabsList.mockResolvedValue([TAB, { ...TAB, tabId: 3 }]);
    calls.activeTab.mockReset();
    calls.browserHistory.mockReset();
    calls.browserHistory.mockResolvedValue([]);
    calls.navigate.mockReset();
    calls.goBack.mockReset();
    calls.goForward.mockReset();
    calls.reload.mockReset();
    calls.historyTarget.mockReset();
    calls.historyTarget.mockResolvedValue({
      ok: true,
      current: { url: TAB.url, title: TAB.title },
      target: { url: TAB.url, title: TAB.title },
    });
    calls.snapshot.mockReset();
    calls.inspectElement.mockReset();
    calls.inspectElement.mockResolvedValue({
      ok: true,
      node: { index: 4, role: "textbox", name: "Input", tag: "input" },
    });
    calls.snapshot.mockResolvedValue({ ok: true, snapshot: ACTION_SNAPSHOT } satisfies BrowserSnapshotResult);
    calls.action.mockReset();
    calls.openTab.mockReset();
    calls.screenshot.mockReset();
    calls.getSettings.mockReset();
    calls.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
    calls.goBack.mockResolvedValue({ ok: true, tab: TAB });
    calls.goForward.mockResolvedValue({ ok: true, tab: TAB });
    calls.reload.mockResolvedValue({ ok: true, tab: TAB });
    siteAccess.reset();
  });

  registerBrowserTools(pi, {
    createClient: () => client,
    createSiteAccess: () => siteAccess,
  });

  test("注册 browser_* 工具，并符合 OpenAI 工具名约束", () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "browser_open",
      "browser_navigate",
      "browser_snapshot",
      "browser_screenshot",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_tabs",
      "browser_history",
      "browser_evaluate",
      "browser_console",
      "browser_dialog",
      "browser_close",
      "browser_press",
      "browser_wait",
      "browser_cdp",
      "browser_clipboard",
      "browser_locator",
      "browser_upload",
      "browser_click_at",
      "browser_move",
      "browser_drag",
      "browser_content",
      "browser_download",
      "browser_downloads",
      "browser_back",
      "browser_forward",
      "browser_reload",
    ]);
    expect(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
  });

  test("browser.open 透传 openTab", async () => {
    calls.openTab.mockResolvedValue({ ok: true, tab: TAB });
    const tool = tools.find((t) => t.name === "browser_open")!;

    const result = await tool.execute("c1", { url: "https://example.com/" }, undefined, undefined, {});

    expect(calls.openTab).toHaveBeenCalledWith("https://example.com/");
    expect(result.details.browser).toMatchObject({ kind: "open", ok: true, tabId: 5 });
    expect(result.content[0].text).toContain("已打开标签页 5");
  });

  test("browser.open 在 openTab 失败时返回错误", async () => {
    calls.openTab.mockResolvedValue({ ok: false, error: "仅支持 http/https 链接" });
    const tool = tools.find((t) => t.name === "browser_open")!;

    const result = await tool.execute("c1", { url: "https://example.com/bad" }, undefined, undefined, {});

    expect(result.details.browser).toMatchObject({ ok: false, error: "仅支持 http/https 链接" });
  });

  test("browser.open 命中 blockSites 时拒绝且不创建 tab", async () => {
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, allowSites: [], blockSites: ["evil.example.net"] },
    });
    const tool = tools.find((t) => t.name === "browser_open")!;

    const result = await tool.execute("c1", { url: "https://evil.example.net/x" }, undefined, undefined, {
      ui: { confirm: vi.fn() },
    } as unknown as ExtensionContext);

    expect(result.details.browser).toMatchObject({ ok: false });
    expect(result.content[0].text).toContain("禁止访问");
    expect(calls.openTab).not.toHaveBeenCalled();
  });

  test("browser.open 未允许站点需用户确认；会话内同 host 不再询问", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    calls.openTab.mockResolvedValue({ ok: true, tab: TAB });
    const tool = tools.find((t) => t.name === "browser_open")!;
    const ctx = { ui: { confirm } } as unknown as ExtensionContext;

    const first = await tool.execute("c1", { url: "https://other.example.net/" }, undefined, undefined, ctx);
    const second = await tool.execute("c2", { url: "https://other.example.net/deep" }, undefined, undefined, ctx);

    expect(first.details.browser.ok).toBe(true);
    expect(second.details.browser.ok).toBe(true);
    expect(calls.openTab).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("browser.open 未允许站点且用户拒绝时不执行", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const tool = tools.find((t) => t.name === "browser_open")!;

    const result = await tool.execute("c1", { url: "https://other.example.net/" }, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(result.details.browser).toMatchObject({ ok: false });
    expect(result.content[0].text).toContain("未允许");
    expect(calls.openTab).not.toHaveBeenCalled();
  });

  test("browser.open 设置读取失败时 fail-closed 拒绝", async () => {
    calls.getSettings.mockRejectedValue(new Error("宿主不可达"));
    const tool = tools.find((t) => t.name === "browser_open")!;

    const result = await tool.execute("c1", { url: "https://other.example.net/" }, undefined, undefined, {
      ui: { confirm: vi.fn() },
    } as unknown as ExtensionContext);

    expect(result.details.browser).toMatchObject({ ok: false });
    expect(calls.openTab).not.toHaveBeenCalled();
  });

  test("browser.navigate 未允许站点需确认后才导航", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    calls.activeTab.mockResolvedValue(TAB);
    calls.navigate.mockResolvedValue({ ok: true, tab: TAB });
    const tool = tools.find((t) => t.name === "browser_navigate")!;

    const result = await tool.execute("c1", { url: "https://other.example.net/" }, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(result.details.browser.ok).toBe(true);
    expect(calls.navigate).toHaveBeenCalledWith(5, "https://other.example.net/");
    expect(confirm).toHaveBeenCalledOnce();
  });

  test("browser.snapshot 渲染编号树并带 details.snapshot", async () => {
    calls.activeTab.mockResolvedValue(TAB);
    calls.snapshot.mockResolvedValue({ ok: true, snapshot: SNAPSHOT } satisfies BrowserSnapshotResult);
    calls.inspectElement.mockResolvedValue({ ok: true, node: SNAPSHOT.tree[1] });
    const tool = tools.find((t) => t.name === "browser_snapshot")!;

    const result = await tool.execute("c1", { withScreenshot: true }, undefined, undefined, {} as ExtensionContext);

    expect(calls.snapshot).toHaveBeenCalledWith(5, { withScreenshot: true });
    expect(result.content[0].text).toContain("[2] button Sign in");
    expect(result.details.snapshot).toEqual(SNAPSHOT);
    expect(result.details.browser).toMatchObject({ kind: "snapshot", ok: true, tabId: 5 });
  });

  test("browser.snapshot 无活跃 tab 时返回错误", async () => {
    calls.activeTab.mockResolvedValue(null);
    const tool = tools.find((t) => t.name === "browser_snapshot")!;

    const result = await tool.execute("c1", {}, undefined, undefined, {} as ExtensionContext);

    expect(result.details.browser).toMatchObject({ ok: false, error: expect.stringContaining("browser_open") });
  });

  test("browser.history requires user approval and returns entries", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const entries = [{ url: "https://example.com/", title: "Example", timestamp: 1 }];
    calls.browserHistory.mockResolvedValue(entries);
    const tool = tools.find((candidate) => candidate.name === "browser_history")!;

    const result = await tool.execute("c1", {}, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.browserHistory).toHaveBeenCalledOnce();
    expect(result.details.browser).toMatchObject({ kind: "history", ok: true });
    expect(result.details.history).toEqual(entries);
  });

  test("browser.history 在始终允许策略下不再弹窗", async () => {
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, historyAccess: "always-allow" },
    });
    const confirm = vi.fn();
    const entries = [{ url: "https://example.com/", title: "Example", timestamp: 1 }];
    calls.browserHistory.mockResolvedValue(entries);
    const tool = tools.find((candidate) => candidate.name === "browser_history")!;

    const result = await tool.execute("c1", {}, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(confirm).not.toHaveBeenCalled();
    expect(calls.browserHistory).toHaveBeenCalledOnce();
    expect(result.details.browser).toMatchObject({ kind: "history", ok: true });
  });

  test("browser.history 在始终拒绝策略下不读取历史", async () => {
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, historyAccess: "always-deny" },
    });
    const confirm = vi.fn();
    const tool = tools.find((candidate) => candidate.name === "browser_history")!;

    const result = await tool.execute("c1", {}, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(confirm).not.toHaveBeenCalled();
    expect(calls.browserHistory).not.toHaveBeenCalled();
    expect(result.details.browser).toMatchObject({ kind: "history", ok: false });
  });

  test("browser.history does not read entries when user rejects", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const tool = tools.find((candidate) => candidate.name === "browser_history")!;

    const result = await tool.execute("c1", {}, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(result.details.browser).toMatchObject({ kind: "history", ok: false });
    expect(calls.browserHistory).not.toHaveBeenCalled();
  });

  test("browser.click staleRef 时提示重新 snapshot", async () => {
    calls.activeTab.mockResolvedValue(TAB);
    calls.inspectElement.mockResolvedValue({
      ok: true,
      node: { index: 9, role: "link", name: "stale", tag: "a" },
    });
    calls.action.mockResolvedValue({ ok: false, error: "元素引用已失效", staleRef: true });
    const tool = tools.find((t) => t.name === "browser_click")!;

    const result = await tool.execute("c1", { elementIndex: 9 }, undefined, undefined, {} as ExtensionContext);

    expect(result.details.browser).toMatchObject({ ok: false });
    expect(result.content[0].text).toContain("重新 browser_snapshot");
    expect(calls.action).toHaveBeenCalledWith(5, expect.objectContaining({ type: "click", elementIndex: 9 }));
  });

  test("browser.type 显式 tabId 优先于活跃 tab", async () => {
    calls.tabsList.mockResolvedValue([{ ...TAB, tabId: 3 }]);
    calls.action.mockResolvedValue({ ok: true });
    const tool = tools.find((t) => t.name === "browser_type")!;

    const result = await tool.execute("c1", { tabId: 3, elementIndex: 4, text: "hello" }, undefined, undefined, {
      ui: { confirm: vi.fn() },
    } as unknown as ExtensionContext);

    expect(calls.activeTab).not.toHaveBeenCalled();
    expect(calls.action).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ type: "type", elementIndex: 4, text: "hello", submit: false }),
    );
    expect(result.details.browser).toMatchObject({ ok: true });
  });

  test("browser.type submit=true 且用户拒绝时不执行", async () => {
    calls.tabsList.mockResolvedValue([{ ...TAB, tabId: 3 }]);
    const confirm = vi.fn().mockResolvedValue(false);
    const tool = tools.find((t) => t.name === "browser_type")!;

    const result = await tool.execute(
      "c1",
      { tabId: 3, elementIndex: 4, text: "x", submit: true },
      undefined,
      undefined,
      { ui: { confirm } } as unknown as ExtensionContext,
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.action).not.toHaveBeenCalled();
    expect(result.details.browser).toMatchObject({ ok: false, error: "用户拒绝提交表单" });
  });

  test("browser.type submit=true 且用户允许时执行", async () => {
    calls.tabsList.mockResolvedValue([{ ...TAB, tabId: 3 }]);
    const confirm = vi.fn().mockResolvedValue(true);
    calls.action.mockResolvedValue({ ok: true });
    const tool = tools.find((t) => t.name === "browser_type")!;

    const result = await tool.execute(
      "c1",
      { tabId: 3, elementIndex: 4, text: "x", submit: true },
      undefined,
      undefined,
      { ui: { confirm } } as unknown as ExtensionContext,
    );

    expect(calls.action).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ type: "type", elementIndex: 4, text: "x", submit: true }),
    );
    expect(result.details.browser).toMatchObject({ ok: true });
  });

  test("browser.type submit 在 unlisted-sites 粒度下对允许站点免确认", async () => {
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, confirmSensitiveActions: "unlisted-sites" },
    });
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://example.com/form" }]);
    calls.action.mockResolvedValue({ ok: true });
    const confirm = vi.fn();
    const tool = tools.find((t) => t.name === "browser_type")!;

    const result = await tool.execute(
      "c1",
      { tabId: 5, elementIndex: 4, text: "x", submit: true },
      undefined,
      undefined,
      { ui: { confirm } } as unknown as ExtensionContext,
    );

    expect(result.details.browser.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.action).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ type: "type", elementIndex: 4, text: "x", submit: true }),
    );
  });

  test("browser.type submit 在 unlisted-sites 粒度下对未允许站点仍确认", async () => {
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, confirmSensitiveActions: "unlisted-sites" },
    });
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://other.example.net/form" }]);
    const confirm = vi.fn().mockResolvedValue(true);
    calls.action.mockResolvedValue({ ok: true });
    const tool = tools.find((t) => t.name === "browser_type")!;

    const result = await tool.execute(
      "c1",
      { tabId: 5, elementIndex: 4, text: "x", submit: true },
      undefined,
      undefined,
      { ui: { confirm } } as unknown as ExtensionContext,
    );

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(result.details.browser.ok).toBe(true);
  });

  test("站点/敏感确认透传工具 AbortSignal：abort 后确认取消且不执行动作", async () => {
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://other.example.net/form" }]);
    calls.inspectElement.mockResolvedValue({
      ok: true,
      node: { index: 7, role: "button", name: "购买并支付", tag: "button" },
    });
    const receivedSignals: AbortSignal[] = [];
    const confirm = vi
      .fn()
      .mockImplementationOnce((_title: string, _message: string, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal) receivedSignals.push(opts.signal);
        return Promise.resolve(true);
      })
      .mockImplementationOnce((_title: string, _message: string, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal) receivedSignals.push(opts.signal);
        return Promise.reject(new DOMException("aborted", "AbortError"));
      });
    const controller = new AbortController();
    const tool = tools.find((candidate) => candidate.name === "browser_click")!;

    const result = await tool.execute("c1", { tabId: 5, elementIndex: 7 }, controller.signal, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(receivedSignals).toHaveLength(2); // 站点确认 + 敏感点击确认
    expect(receivedSignals.every((signal) => signal === controller.signal)).toBe(true);
    expect(result.details.browser.ok).toBe(false);
    expect(calls.action).not.toHaveBeenCalled();
  });

  test("browser.history 确认透传工具 AbortSignal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const confirm = vi.fn((_title: string, _message: string, opts?: { signal?: AbortSignal }) => {
      receivedSignal = opts?.signal;
      return Promise.resolve(true);
    });
    calls.browserHistory.mockResolvedValue([]);
    const controller = new AbortController();
    const tool = tools.find((candidate) => candidate.name === "browser_history")!;

    const result = await tool.execute("c1", {}, controller.signal, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(receivedSignal).toBe(controller.signal);
    expect(result.details.browser.ok).toBe(true);
  });

  test("history action checks the destination site before calling back", async () => {
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://example.com/current" }]);
    calls.historyTarget.mockResolvedValue({
      ok: true,
      current: { url: "https://example.com/current", title: "Current" },
      target: { url: "https://evil.example.net/", title: "Blocked" },
    });
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, blockSites: ["evil.example.net"] },
    });
    const tool = tools.find((candidate) => candidate.name === "browser_back")!;

    const result = await tool.execute("c1", { tabId: 5 }, undefined, undefined, {
      ui: { confirm: vi.fn() },
    } as unknown as ExtensionContext);

    expect(result.details.browser.ok).toBe(false);
    expect(calls.historyTarget).toHaveBeenCalledWith(5, "back", undefined);
    expect(calls.goBack).not.toHaveBeenCalled();
  });

  test("browser.type submit 设置读取失败时保守拒绝", async () => {
    calls.getSettings.mockRejectedValue(new Error("宿主不可达"));
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://example.com/form" }]);
    const confirm = vi.fn().mockResolvedValue(true);
    calls.action.mockResolvedValue({ ok: true });
    const tool = tools.find((t) => t.name === "browser_type")!;

    const result = await tool.execute(
      "c1",
      { tabId: 5, elementIndex: 4, text: "x", submit: true },
      undefined,
      undefined,
      { ui: { confirm } } as unknown as ExtensionContext,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(calls.action).not.toHaveBeenCalled();
    expect(result.details.browser.ok).toBe(false);
  });

  test.each([
    ["browser_tabs", {}],
    ["browser_snapshot", {}],
    ["browser_screenshot", {}],
    ["browser_click", { tabId: 5, elementIndex: 2 }],
    ["browser_type", { tabId: 5, elementIndex: 4, text: "x" }],
    ["browser_scroll", { tabId: 5, direction: "down" }],
    ["browser_back", { tabId: 5 }],
    ["browser_forward", { tabId: 5 }],
    ["browser_reload", { tabId: 5 }],
  ] as const)("blocked 当前站点拒绝 %s 且不触发底层操作", async (name, params) => {
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, allowSites: [], blockSites: ["evil.example.net"] },
    });
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://evil.example.net/" }]);
    const tool = tools.find((candidate) => candidate.name === name)!;
    const result = await tool.execute("c1", params, undefined, undefined, {
      ui: { confirm: vi.fn() },
    } as unknown as ExtensionContext);

    expect(result.details.browser.ok).toBe(false);
    expect(calls.snapshot).not.toHaveBeenCalled();
    expect(calls.screenshot).not.toHaveBeenCalled();
    expect(calls.action).not.toHaveBeenCalled();
    expect(calls.goBack).not.toHaveBeenCalled();
    expect(calls.goForward).not.toHaveBeenCalled();
    expect(calls.reload).not.toHaveBeenCalled();
  });

  test("unlisted 当前站点用户拒绝时 snapshot 不执行", async () => {
    calls.tabsList.mockResolvedValue([{ ...TAB, url: "https://other.example.net/" }]);
    const confirm = vi.fn().mockResolvedValue(false);
    const tool = tools.find((candidate) => candidate.name === "browser_snapshot")!;

    const result = await tool.execute("c1", { tabId: 5 }, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(result.details.browser.ok).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.snapshot).not.toHaveBeenCalled();
  });

  test("点击购买按钮在动作前要求敏感确认", async () => {
    calls.inspectElement.mockResolvedValue({
      ok: true,
      node: { index: 7, role: "button", name: "购买并支付", tag: "button" },
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const tool = tools.find((candidate) => candidate.name === "browser_click")!;

    const result = await tool.execute("c1", { tabId: 5, elementIndex: 7 }, undefined, undefined, {
      ui: { confirm },
    } as unknown as ExtensionContext);

    expect(result.details.browser.ok).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.action).not.toHaveBeenCalled();
  });

  test("点击指向禁止站点的链接在 CDP 前拒绝", async () => {
    calls.inspectElement.mockResolvedValue({
      ok: true,
      node: { index: 8, role: "link", name: "外部链接", tag: "a", attrs: { href: "https://evil.example.net/" } },
    });
    calls.getSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings, blockSites: ["evil.example.net"] },
    });
    const tool = tools.find((candidate) => candidate.name === "browser_click")!;

    const result = await tool.execute("c1", { tabId: 5, elementIndex: 8 }, undefined, undefined, {
      ui: { confirm: vi.fn() },
    } as unknown as ExtensionContext);

    expect(result.details.browser.ok).toBe(false);
    expect(calls.action).not.toHaveBeenCalled();
  });
  test("env 缺失（无注入 client）时返回服务不可用", async () => {
    const { pi: piNoClient, tools: toolsNoClient } = createFakePi();
    registerBrowserTools(piNoClient, {});
    delete process.env.PI_BROWSER_HOST_PORT;
    delete process.env.PI_BROWSER_TOKEN;
    const tool = toolsNoClient.find((t) => t.name === "browser_tabs")!;

    const result = await tool.execute("c1", {}, undefined, undefined, {} as ExtensionContext);

    expect(result.details.browser.ok).toBe(false);
    expect(result.content[0].text).toContain("浏览器宿主服务未就绪");
  });
});
