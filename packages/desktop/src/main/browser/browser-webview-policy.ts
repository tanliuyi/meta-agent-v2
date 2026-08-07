import type { WebContents } from "electron";
import { BROWSER_PARTITION } from "../../shared/browser-contracts.ts";

/** Install the main-process policy for every webview attached to the app window. */
export function installBrowserWebviewSecurity(webContents: WebContents): () => void {
  const onWillAttach = (
    event: Electron.Event,
    webPreferences: Electron.WebPreferences,
    params: Record<string, string>,
  ): void => {
    // Never allow an untrusted renderer to supply code that runs before the guest page.
    delete webPreferences.preload;
    delete params.preload;
    delete params.webpreferences;

    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;
    webPreferences.partition = BROWSER_PARTITION;

    if (params.partition !== BROWSER_PARTITION || !isBrowserWebviewUrl(params.src)) {
      event.preventDefault();
    }
  };

  webContents.on("will-attach-webview", onWillAttach);
  return () => webContents.off("will-attach-webview", onWillAttach);
}

/** Initial URLs accepted by the browser guest. Later navigations are checked by BrowserManager. */
export function isBrowserWebviewUrl(raw: string | undefined): boolean {
  if (raw === "about:blank") return true;
  if (typeof raw !== "string" || raw.length === 0) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
