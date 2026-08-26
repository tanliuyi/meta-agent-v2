import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { clipboard as electronClipboard } from "electron";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebContentsHostController } from "../src/main/browser/browser-host-controller.ts";

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn(() => Promise.resolve()), readText: vi.fn(() => Promise.resolve("mocked")) },
}));

const AX_TREE = {
  nodes: [
    { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["button"] },
    {
      nodeId: "button",
      role: { value: "button" },
      name: { value: "Submit" },
      backendDOMNodeId: 1,
    },
  ],
};
const SCREENSHOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class FakeWebContents extends EventEmitter {
  destroyed = false;
  url = "https://example.com/";
  title = "Example";
  box = [10, 20, 50, 20, 50, 40, 10, 40];
  hangRuntime = false;
  debuggerDetached = false;
  liveTarget = { tag: "button", name: "Submit", selector: "#submit", attrs: { type: "submit", name: "submit" } };
  loadURL = vi.fn(async (url: string) => {
    const event = { preventDefault: vi.fn() };
    this.lastNavigationEvent = event;
    this.emit("will-navigate", event, url);
    if (!event.preventDefault.mock.calls.length) this.url = url;
  });
  stop = vi.fn();
  reload = vi.fn();
  setWindowOpenHandler = vi.fn((handler: Parameters<WebContents["setWindowOpenHandler"]>[0]) => {
    this.windowOpenHandler = handler;
  });
  windowOpenHandler: Parameters<WebContents["setWindowOpenHandler"]>[0] | undefined;
  lastWindowOpenHandler: ((details: { url: string }) => { action: "allow" | "deny" }) | undefined;
  lastNavigationEvent: { preventDefault: ReturnType<typeof vi.fn> } | undefined;
  navigationHistory = {
    canGoBack: () => true,
    canGoForward: () => true,
    getActiveIndex: () => 1,
    getAllEntries: () => [
      { url: "https://before.example/", title: "Before" },
      { url: this.url, title: this.title },
      { url: "https://after.example/", title: "After" },
    ],
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  private readonly sessionEmitter = new EventEmitter();
  get session(): EventEmitter {
    // 对齐 Electron：guest 销毁后访问 session 抛 "Object has been destroyed"。
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.sessionEmitter;
  }
  downloadURL = vi.fn();
  debugger = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => {
      this.debuggerDetached = false;
    }),
    detach: vi.fn(() => {
      this.debuggerDetached = true;
      this.debugger.emit("detach");
    }),
    sendCommand: vi.fn(async (method: string, params?: unknown) => this.command(method, params)),
  });

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }

  isLoading(): boolean {
    return false;
  }

  async command(method: string, params?: unknown): Promise<unknown> {
    if (this.hangRuntime && method === "Runtime.evaluate") {
      return new Promise<never>((_resolve, reject) => {
        const onDetach = () => {
          this.debugger.off("detach", onDetach);
          reject(new Error("debugger detached"));
        };
        this.debugger.on("detach", onDetach);
      });
    }
    switch (method) {
      case "DOM.enable":
        return {};
      case "Runtime.evaluate":
        return { result: { value: { width: 800, height: 600, dpr: 1 } } };
      case "Accessibility.getFullAXTree":
        return AX_TREE;
      case "DOM.describeNode":
        return { node: { nodeName: "BUTTON", attributes: ["type", "submit", "name", "submit"] } };
      case "DOM.resolveNode":
        return { object: { objectId: "button-object" } };
      case "Runtime.callFunctionOn":
        return {
          result: {
            value:
              typeof params === "object" &&
              params !== null &&
              "functionDeclaration" in params &&
              String((params as { functionDeclaration?: unknown }).functionDeclaration).includes("attrs")
                ? this.liveTarget
                : "#submit",
          },
        };
      case "DOM.getBoxModel":
        return { model: { content: this.box } };
      case "Page.captureScreenshot":
        return { data: SCREENSHOT_PNG };
      case "Runtime.addBinding":
      case "Input.dispatchMouseEvent":
      case "Input.insertText":
      case "Input.dispatchKeyEvent":
        return {};
      default:
        throw new Error(`Unexpected CDP method: ${method}`);
    }
  }
}

const hosts: WebContentsHostController[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

describe("WebContentsHostController CDP integration", () => {
  test("captureScreenshot 从 guest surface 获取截图，避免截入宿主窗口", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await expect(host.captureScreenshot()).resolves.toMatchObject({ width: 1, height: 1 });
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
  });

  test("Runtime binding 事件只交给宿主回调，不进入 Agent CDP 缓冲", async () => {
    const webContents = new FakeWebContents();
    const onRuntimeBinding = vi.fn();
    const host = new WebContentsHostController(webContents as unknown as WebContents, {
      cdpTimeoutMs: 200,
      onRuntimeBinding,
    });
    hosts.push(host);

    await host.addRuntimeBinding("__piSecureBinding");
    await host.addRuntimeBinding("__piSecureBinding");
    expect(
      webContents.debugger.sendCommand.mock.calls.filter(([method]) => method === "Runtime.addBinding"),
    ).toHaveLength(1);
    webContents.debugger.detach();
    await host.addRuntimeBinding("__piSecureBinding");
    expect(
      webContents.debugger.sendCommand.mock.calls.filter(([method]) => method === "Runtime.addBinding"),
    ).toHaveLength(2);
    webContents.debugger.emit("message", {}, "Runtime.bindingCalled", {
      name: "__piSecureBinding",
      payload: "secret",
    });

    expect(onRuntimeBinding).toHaveBeenCalledWith("__piSecureBinding", "secret");
    await expect(host.readCdpEvents()).resolves.not.toContainEqual(
      expect.objectContaining({ method: "Runtime.bindingCalled" }),
    );
  });

  test("first action without a snapshot returns stale without deadlocking the queue", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await expect(host.performAction({ type: "click", elementIndex: 1 })).rejects.toMatchObject({
      name: "StaleReferenceError",
    });
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.anything());
  });

  test("refreshes bounds from backendDOMNodeId and invalidates the index after scroll", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await host.snapshot({ withScreenshot: false });
    webContents.box = [100, 120, 160, 120, 160, 160, 100, 160];
    await host.performAction({ type: "click", elementIndex: 1 });
    const mouseCalls = webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls[0]?.[1]).toMatchObject({ x: 130, y: 140 });

    const before = webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === "Accessibility.getFullAXTree",
    ).length;
    await host.performAction({ type: "scroll", direction: "down" });
    await host.snapshot({ withScreenshot: false });
    await host.performAction({ type: "click", elementIndex: 1 });
    const after = webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === "Accessibility.getFullAXTree",
    ).length;
    expect(after).toBeGreaterThan(before);
  });

  test("timeout cancels the current generation and allows a later CDP command", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 20 });
    hosts.push(host);
    webContents.hangRuntime = true;

    await expect(host.snapshot({ withScreenshot: false })).rejects.toThrow("CDP 命令超时");
    expect(webContents.stop).toHaveBeenCalled();
    expect(webContents.debugger.detach).toHaveBeenCalled();

    webContents.hangRuntime = false;
    await expect(host.snapshot({ withScreenshot: false })).resolves.toMatchObject({ url: "https://example.com/" });
  });

  test("permanent navigation boundary blocks privileged guest redirects and direct navigation", () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, {
      allowNavigation: (url) => url.startsWith("browser://"),
    });
    hosts.push(host);

    const internalEvent = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", internalEvent, "browser://passwords");
    expect(internalEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", externalEvent, "https://evil.example/");
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();

    const redirectEvent = { preventDefault: vi.fn() };
    webContents.emit("will-redirect", redirectEvent, "https://evil.example/");
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();
  });

  test("agent navigation guard remains active briefly after load completion", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, {
      onAgentNavigation: (url, _current, approved) => url === approved,
    });
    hosts.push(host);

    await host.navigate("https://good.example/", {
      agent: true,
      navigationApprovalUrl: "https://good.example/",
    });
    webContents.emit("did-navigate", {}, "https://good.example/");
    const delayedEvent = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", delayedEvent, "https://evil.example/");

    expect(delayedEvent.preventDefault).toHaveBeenCalledOnce();
  });

  test("history navigation resolves on same-document navigation", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    const navigation = host.goBack();
    webContents.emit("did-navigate-in-page", {}, "https://example.com/#section", true);
    await expect(navigation).resolves.toBeUndefined();
  });

  test("agent navigation guard blocks an unapproved will-navigate before URL change", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, {
      onAgentNavigation: (url, _current, approved) => url === approved,
    });
    hosts.push(host);

    await host.navigate("https://evil.example/", { agent: true });
    expect(webContents.lastNavigationEvent?.preventDefault).toHaveBeenCalledOnce();
    expect(webContents.getURL()).toBe("https://example.com/");

    await host.navigate("https://good.example/", {
      agent: true,
      navigationApprovalUrl: "https://good.example/",
    });
    expect(webContents.lastNavigationEvent?.preventDefault).not.toHaveBeenCalled();
    expect(webContents.getURL()).toBe("https://good.example/");
  });

  test("agent action validates the live DOM target after approval", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await host.snapshot({ withScreenshot: false });
    await expect(
      host.performAction({
        type: "click",
        elementIndex: 1,
        target: {
          pageUrl: "https://example.com/",
          role: "button",
          tag: "button",
          name: "Submit",
          selector: "#submit",
          attrs: { type: "submit", name: "submit" },
        },
      }),
    ).resolves.toMatchObject({ url: "https://example.com/" });

    webContents.liveTarget = { ...webContents.liveTarget, name: "Delete" };
    await expect(
      host.performAction({
        type: "click",
        elementIndex: 1,
        target: {
          pageUrl: "https://example.com/",
          role: "button",
          tag: "button",
          name: "Submit",
          selector: "#submit",
          attrs: { type: "submit", name: "submit" },
        },
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("redirects use the same agent navigation guard as direct navigation", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, {
      onAgentNavigation: (url, _current, approved) => url === approved,
    });
    hosts.push(host);

    const event = { preventDefault: vi.fn() };
    webContents.emit("will-redirect", event, "https://evil.example/");
    expect(event.preventDefault).not.toHaveBeenCalled();

    await host.snapshot({ withScreenshot: false });
    await host.performAction({ type: "click", elementIndex: 1 }, { agent: true });
    const redirect = { preventDefault: vi.fn() };
    webContents.emit("will-redirect", redirect, "https://evil.example/");
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
  });

  test("guest window.open is denied and forwarded as a new tab request", () => {
    const webContents = new FakeWebContents();
    const onPopup = vi.fn();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { onPopup });
    hosts.push(host);

    const response = webContents.windowOpenHandler?.({ url: "https://popup.example/" } as never);
    expect(response).toEqual({ action: "deny" });
    expect(onPopup).toHaveBeenCalledWith("https://popup.example/");
  });

  test("forwards guest context-menu events and removes the listener on dispose", () => {
    const webContents = new FakeWebContents();
    const onContextMenu = vi.fn();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { onContextMenu });
    hosts.push(host);
    const event = { preventDefault: vi.fn() };
    const params = { pageURL: "https://example.com/", x: 10, y: 20 } as unknown as Electron.ContextMenuParams;

    webContents.emit("context-menu", event, params);
    expect(onContextMenu).toHaveBeenCalledWith(event, params);

    host.dispose();
    webContents.emit("context-menu", event, params);
    expect(onContextMenu).toHaveBeenCalledOnce();
  });

  test("guest destroyed 后 dispose 不抛（清理回调访问已销毁 webContents）", () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents);
    hosts.push(host);

    // 模拟 guest 销毁：destroyed 事件派发时 webContents 已标记销毁，
    // session getter 访问抛 "Object has been destroyed"（真实崩溃路径）。
    webContents.destroy();
    expect(() => host.dispose()).not.toThrow();
    expect(() => host.dispose()).not.toThrow();
  });
});

describe("WebContentsHostController 新能力（对齐 Codex browser_use）", () => {
  test("pressKey 组合键：修饰键按下→主键 down/up→修饰键松开（ControlOrMeta 平台解析）", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);
    webContents.debugger.sendCommand.mockClear();

    await host.pressKey("ControlOrMeta+Enter");

    const calls = webContents.debugger.sendCommand.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    // 4 次：修饰键 down、主键 down、主键 up、修饰键 up
    expect(calls.length).toBe(4);
    const [modDown, keyDown, keyUp, modUp] = calls.map((call: unknown[]) => call[1]);
    const modifier = process.platform === "darwin" ? { key: "Meta", modifiers: 4 } : { key: "Control", modifiers: 2 };
    expect(modDown).toMatchObject({ type: "rawKeyDown", ...modifier });
    expect(keyDown).toMatchObject({ type: "keyDown", key: "Enter", modifiers: modifier.modifiers });
    expect(keyUp).toMatchObject({ type: "keyUp", key: "Enter", modifiers: modifier.modifiers });
    expect(modUp).toMatchObject({ type: "keyUp", ...modifier });
  });

  test("pressKey 普通按键与未知按键错误", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await host.pressKey("Escape");
    const calls = webContents.debugger.sendCommand.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchKeyEvent",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toMatchObject({ type: "rawKeyDown", key: "Escape", code: "Escape" });

    await expect(host.pressKey("NoSuchKey")).rejects.toThrow("未知按键");
  });

  test("evaluate 返回序列化结果与异常描述", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { type: "number", value: 2 } };
      return { result: { value: { width: 800, height: 600, dpr: 1 } } };
    });
    const ok = await host.evaluate("1 + 1");
    expect(ok).toMatchObject({ ok: true, value: "2", type: "number" });
  });

  test("clipboard 读写经 Electron 系统剪贴板", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await host.clipboardWriteText("hello");
    expect(electronClipboard.writeText).toHaveBeenCalledWith("hello");
    await expect(host.clipboardReadText()).resolves.toBe("mocked");

    vi.mocked(electronClipboard.writeText).mockRejectedValueOnce(new Error("clipboard write failed"));
    await expect(host.clipboardWriteText("failure")).rejects.toThrow("clipboard write failed");
  });

  test("downloadEvents 记录 will-download（含 setSavePath 与 done 后最终路径）", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    const session = webContents.session as unknown as EventEmitter;
    const item = new EventEmitter() as unknown as {
      getURL: () => string;
      getFilename: () => string;
      getSavePath: () => string;
      setSavePath: ReturnType<typeof vi.fn>;
      once: (event: string, cb: () => void) => void;
    };
    Object.assign(item, {
      getURL: () => "https://example.com/file.zip",
      getFilename: () => "file.zip",
      getSavePath: () => "/tmp/file.zip",
      setSavePath: vi.fn(),
    });

    session.emit("will-download", {}, item);
    (item as EventEmitter).emit("done");

    const downloads = await host.downloadEvents();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ url: "https://example.com/file.zip", filename: "file.zip" });
  });

  test("downloadMedia 设置保存路径并触发 downloadURL", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);
    webContents.downloadURL = vi.fn();

    await host.downloadMedia("https://example.com/file.zip", "/tmp/saved.zip");
    expect(webContents.downloadURL).toHaveBeenCalledWith("https://example.com/file.zip");

    await expect(host.downloadMedia("file:///etc/passwd", "/tmp/x")).rejects.toThrow("仅支持 http/https");
  });

  test("waitFor timeout 分支抛错", async () => {
    const webContents = new FakeWebContents();
    const host = new WebContentsHostController(webContents as unknown as WebContents, { cdpTimeoutMs: 200 });
    hosts.push(host);

    await expect(host.waitFor({ timeoutMs: 10 })).resolves.toBeUndefined();
  });
});
