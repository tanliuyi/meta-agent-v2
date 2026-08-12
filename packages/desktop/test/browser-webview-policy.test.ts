import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";
import {
  installBrowserWebviewSecurity,
  isBrowserInternalWebContents,
  isBrowserWebviewUrl,
} from "../src/main/browser/browser-webview-policy.ts";
import { browserPartitionFor, isBrowserSessionPartition } from "../src/shared/browser-contracts.ts";

const SESSION_PARTITION = browserPartitionFor({ projectId: "proj-a", threadId: "thread-a" });

function attachEvent(): Electron.Event {
  return { preventDefault: vi.fn() } as unknown as Electron.Event;
}

describe("browser webview security policy", () => {
  test("allows only per-session browser partitions and safe initial URLs", () => {
    const webContents = new EventEmitter() as unknown as WebContents;
    const remove = installBrowserWebviewSecurity(webContents);
    const event = attachEvent();
    const preferences: Electron.WebPreferences = {
      preload: "/tmp/attacker-preload.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      webviewTag: true,
    };
    const params: Record<string, string> = {
      partition: SESSION_PARTITION,
      src: "about:blank",
      preload: "/tmp/attacker-preload.js",
      webpreferences: "nodeIntegration=yes",
    };

    webContents.emit("will-attach-webview", event, preferences, params);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(preferences.preload).toBeUndefined();
    expect(params.preload).toBeUndefined();
    expect(params.webpreferences).toBeUndefined();
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.nodeIntegrationInSubFrames).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
    expect(preferences.webviewTag).toBe(false);
    // 保留 renderer 按会话身份设置的分区。
    expect(preferences.partition).toBe(SESSION_PARTITION);

    remove();
  });

  test("rejects an unexpected partition or initial URL", () => {
    const webContents = new EventEmitter() as unknown as WebContents;
    const remove = installBrowserWebviewSecurity(webContents);
    const partitionEvent = attachEvent();
    const partitionPreferences: Electron.WebPreferences = {};
    webContents.emit("will-attach-webview", partitionEvent, partitionPreferences, {
      partition: "persist:other",
      src: "about:blank",
    });
    expect(partitionEvent.preventDefault).toHaveBeenCalledOnce();

    const globalPartitionEvent = attachEvent();
    webContents.emit(
      "will-attach-webview",
      globalPartitionEvent,
      {},
      {
        partition: "persist:browser",
        src: "about:blank",
      },
    );
    expect(globalPartitionEvent.preventDefault).toHaveBeenCalledOnce();

    const urlEvent = attachEvent();
    const urlPreferences: Electron.WebPreferences = {};
    webContents.emit("will-attach-webview", urlEvent, urlPreferences, {
      partition: SESSION_PARTITION,
      src: "file:///etc/passwd",
    });
    expect(urlEvent.preventDefault).toHaveBeenCalledOnce();

    remove();
  });

  test("只给已知 browser:// WebUI 注入受信 preload", () => {
    const webContents = new EventEmitter() as unknown as WebContents;
    const remove = installBrowserWebviewSecurity(webContents, "/app/preload/browser-internal.cjs");
    const internalEvent = attachEvent();
    const internalPreferences: Electron.WebPreferences = {};
    webContents.emit("will-attach-webview", internalEvent, internalPreferences, {
      partition: SESSION_PARTITION,
      src: "browser://history",
      preload: "/tmp/attacker-preload.js",
    });
    expect(internalEvent.preventDefault).not.toHaveBeenCalled();
    expect(internalPreferences.preload).toBe("/app/preload/browser-internal.cjs");

    const websiteEvent = attachEvent();
    const websitePreferences: Electron.WebPreferences = { preload: "/tmp/attacker-preload.js" };
    webContents.emit("will-attach-webview", websiteEvent, websitePreferences, {
      partition: SESSION_PARTITION,
      src: "https://example.com/",
      preload: "/tmp/attacker-preload.js",
    });
    expect(websiteEvent.preventDefault).not.toHaveBeenCalled();
    expect(websitePreferences.preload).toBeUndefined();
    remove();
  });

  test("登记并清理 browser:// 特权 guest 身份", () => {
    const webContents = new EventEmitter() as unknown as WebContents;
    const guestEmitter = new EventEmitter();
    const guest = Object.assign(guestEmitter, {
      id: 72,
      getURL: () => "",
      getLastWebPreferences: () => ({ preload: "/app/preload/browser-internal.cjs" }),
    }) as unknown as WebContents;
    const remove = installBrowserWebviewSecurity(webContents, "/app/preload/browser-internal.cjs");

    webContents.emit(
      "will-attach-webview",
      attachEvent(),
      {},
      {
        partition: SESSION_PARTITION,
        src: "browser://history",
      },
    );
    webContents.emit("did-attach-webview", {}, guest);
    guestEmitter.emit("did-navigate", {}, "browser://history");
    expect(isBrowserInternalWebContents(72)).toBe(true);

    guestEmitter.emit("destroyed");
    expect(isBrowserInternalWebContents(72)).toBe(false);
    remove();
  });

  test("交错 attach 不会把普通 guest 误标为特权 guest", () => {
    const webContents = new EventEmitter() as unknown as WebContents;
    const internalEmitter = new EventEmitter();
    const externalEmitter = new EventEmitter();
    const internalGuest = Object.assign(internalEmitter, {
      id: 73,
      getURL: () => "",
      getLastWebPreferences: () => ({ preload: "/app/preload/browser-internal.cjs" }),
    }) as unknown as WebContents;
    const externalGuest = Object.assign(externalEmitter, {
      id: 74,
      getURL: () => "https://example.com/",
      getLastWebPreferences: () => ({}),
    }) as unknown as WebContents;
    const remove = installBrowserWebviewSecurity(webContents, "/app/preload/browser-internal.cjs");

    webContents.emit(
      "will-attach-webview",
      attachEvent(),
      {},
      {
        partition: SESSION_PARTITION,
        src: "browser://history",
      },
    );
    webContents.emit(
      "will-attach-webview",
      attachEvent(),
      {},
      {
        partition: SESSION_PARTITION,
        src: "https://example.com/",
      },
    );
    webContents.emit("did-attach-webview", {}, externalGuest);
    webContents.emit("did-attach-webview", {}, internalGuest);

    expect(isBrowserInternalWebContents(73)).toBe(true);
    expect(isBrowserInternalWebContents(74)).toBe(false);
    const externalNavigation = attachEvent();
    internalEmitter.emit("will-navigate", externalNavigation, "https://evil.example/");
    expect(externalNavigation.preventDefault).toHaveBeenCalledOnce();
    remove();
  });

  test("recognizes only about:blank, HTTP(S), and known browser:// URLs", () => {
    expect(isBrowserWebviewUrl("about:blank")).toBe(true);
    expect(isBrowserWebviewUrl("https://example.com/")).toBe(true);
    expect(isBrowserWebviewUrl("http://localhost:3000/")).toBe(true);
    expect(isBrowserWebviewUrl("browser://history")).toBe(true);
    expect(isBrowserWebviewUrl("browser://passwords/")).toBe(true);
    expect(isBrowserWebviewUrl("browser://unknown")).toBe(false);
    expect(isBrowserWebviewUrl("browser://history/extra")).toBe(false);
    expect(isBrowserWebviewUrl("file:///tmp/index.html")).toBe(false);
    expect(isBrowserWebviewUrl("javascript:alert(1)")).toBe(false);
    expect(isBrowserWebviewUrl(undefined)).toBe(false);
  });

  test("isBrowserSessionPartition 只接受会话分区格式", () => {
    expect(isBrowserSessionPartition(SESSION_PARTITION)).toBe(true);
    expect(isBrowserSessionPartition("persist:browser")).toBe(false);
    expect(isBrowserSessionPartition("persist:other")).toBe(false);
    expect(isBrowserSessionPartition("persist:browser-zzzzzzzzzzzzzzzz")).toBe(false);
    expect(isBrowserSessionPartition("")).toBe(false);
    // 不同会话分区互不相同。
    expect(browserPartitionFor({ projectId: "proj-a", threadId: "thread-a" })).not.toBe(
      browserPartitionFor({ projectId: "proj-a", threadId: "thread-b" }),
    );
  });
});
