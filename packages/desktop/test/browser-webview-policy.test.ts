import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";
import { installBrowserWebviewSecurity, isBrowserWebviewUrl } from "../src/main/browser/browser-webview-policy.ts";
import { BROWSER_PARTITION } from "../src/shared/browser-contracts.ts";

function attachEvent(): Electron.Event {
  return { preventDefault: vi.fn() } as unknown as Electron.Event;
}

describe("browser webview security policy", () => {
  test("allows only the browser partition and safe initial URLs", () => {
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
      partition: BROWSER_PARTITION,
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
    expect(preferences.partition).toBe(BROWSER_PARTITION);

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

    const urlEvent = attachEvent();
    const urlPreferences: Electron.WebPreferences = {};
    webContents.emit("will-attach-webview", urlEvent, urlPreferences, {
      partition: BROWSER_PARTITION,
      src: "file:///etc/passwd",
    });
    expect(urlEvent.preventDefault).toHaveBeenCalledOnce();

    remove();
  });

  test("recognizes only about:blank and HTTP(S) URLs", () => {
    expect(isBrowserWebviewUrl("about:blank")).toBe(true);
    expect(isBrowserWebviewUrl("https://example.com/")).toBe(true);
    expect(isBrowserWebviewUrl("http://localhost:3000/")).toBe(true);
    expect(isBrowserWebviewUrl("file:///tmp/index.html")).toBe(false);
    expect(isBrowserWebviewUrl("javascript:alert(1)")).toBe(false);
    expect(isBrowserWebviewUrl(undefined)).toBe(false);
  });
});
