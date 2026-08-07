import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebContentsHostController } from "../src/main/browser/browser-host-controller.ts";

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

class FakeWebContents extends EventEmitter {
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
});
