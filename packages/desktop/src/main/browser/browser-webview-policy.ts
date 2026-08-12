import type { WebContents } from "electron";
import { isBrowserSessionPartition } from "../../shared/browser-contracts.ts";
import { parseBrowserInternalPage } from "../../shared/browser-internal-contracts.ts";

const internalBrowserWebContentsIds = new Set<number>();

export function isBrowserInternalWebContents(webContentsId: number): boolean {
  return internalBrowserWebContentsIds.has(webContentsId);
}

/**
 * Install the main-process policy for every webview attached to the app window.
 *
 * 每个会话使用独立分区（`persist:browser-<hash>`，见 browserPartitionFor）。
 * 分区由 renderer 按会话身份设置，这里只做格式白名单校验 + 安全加固；
 * 身份与分区的绑定由 BrowserManager.attach 在 main 侧校验（webContents 的
 * session 必须与会话身份对应的 partition session 一致）。
 */
export function installBrowserWebviewSecurity(
  webContents: WebContents,
  browserInternalPreloadPath?: string,
): () => void {
  const guestCleanups = new Set<() => void>();
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
    if (browserInternalPreloadPath && parseBrowserInternalPage(params.src) !== null) {
      webPreferences.preload = browserInternalPreloadPath;
    }

    const partition = params.partition ?? "";
    if (!isBrowserSessionPartition(partition)) {
      event.preventDefault();
      return;
    }
    webPreferences.partition = partition;
    if (!isBrowserWebviewUrl(params.src)) {
      event.preventDefault();
    }
  };
  const onDidAttach = (_event: Electron.Event, guest: WebContents): void => {
    const preferences = (
      guest as WebContents & { getLastWebPreferences(): Electron.WebPreferences }
    ).getLastWebPreferences();
    let internal = browserInternalPreloadPath !== undefined && preferences.preload === browserInternalPreloadPath;
    if (internal) internalBrowserWebContentsIds.add(guest.id);
    const markInternal = (url: string): void => {
      if (parseBrowserInternalPage(url) === null) return;
      internal = true;
      internalBrowserWebContentsIds.add(guest.id);
    };
    const guardInternalNavigation = (event: Electron.Event, url: string): void => {
      markInternal(guest.getURL());
      if (internal && parseBrowserInternalPage(url) === null) event.preventDefault();
    };
    const onDidNavigate = (_event: Electron.Event, url: string): void => markInternal(url);
    const cleanup = (): void => {
      internalBrowserWebContentsIds.delete(guest.id);
      guest.off("will-navigate", guardInternalNavigation);
      guest.off("will-redirect", guardInternalNavigation);
      guest.off("did-navigate", onDidNavigate);
      guest.off("destroyed", cleanup);
      guestCleanups.delete(cleanup);
    };
    markInternal(guest.getURL());
    guest.on("will-navigate", guardInternalNavigation);
    guest.on("will-redirect", guardInternalNavigation);
    guest.on("did-navigate", onDidNavigate);
    guest.once("destroyed", cleanup);
    guestCleanups.add(cleanup);
  };

  webContents.on("will-attach-webview", onWillAttach);
  webContents.on("did-attach-webview", onDidAttach);
  return () => {
    for (const cleanup of [...guestCleanups]) cleanup();
    webContents.off("will-attach-webview", onWillAttach);
    webContents.off("did-attach-webview", onDidAttach);
  };
}

/** Initial URLs accepted by the browser guest. browser:// is restricted to known internal pages. */
export function isBrowserWebviewUrl(raw: string | undefined): boolean {
  if (raw === "about:blank") return true;
  if (typeof raw !== "string" || raw.length === 0) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || parseBrowserInternalPage(raw) !== null;
  } catch {
    return false;
  }
}
