/**
 * Electron `<webview>` 标签的 renderer 侧最小类型声明。
 *
 * renderer（sandbox: true、contextIsolation: true）不依赖 electron 包，
 * 这里只声明内置浏览器面板用到的 WebviewTag 方法子集与事件 payload 类型，
 * 字段与 electron.d.ts 的 Electron.WebviewTag 保持一致。
 *
 * 事件经 HTMLElement 的 string 重载注册（DOM 库自带），回调内用下方
 * payload 接口收窄事件对象。
 */

/** `<webview>` 标签方法子集（对应 Electron.WebviewTag）。 */
export interface BrowserWebviewElement extends HTMLElement {
  /** guest webContents id；未 attach 时为 -1。 */
  getWebContentsId(): number;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  loadURL(url: string, options?: { userAgent?: string }): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  getZoomFactor(): number;
  getZoomLevel(): number;
  print(options?: { silent?: boolean; printBackground?: boolean }): Promise<void>;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  setZoomFactor(factor: number): void;
}

/** page-title-updated 事件 payload。 */
export interface BrowserWebviewPageTitleEvent extends Event {
  title: string;
  explicitSet: boolean;
}

/** did-navigate / did-navigate-in-page 事件 payload。 */
export interface BrowserWebviewNavigateEvent extends Event {
  url: string;
  isMainFrame: boolean;
}

/** render-process-gone 事件 payload。 */
export interface BrowserWebviewRenderProcessGoneEvent extends Event {
  reason: string;
  exitCode: number;
}

/** did-fail-load 事件 payload。 */
export interface BrowserWebviewFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

/** ipc-message 事件 payload（仅 browser:// WebUI 的 sendToHost）。 */
export interface BrowserWebviewIpcMessageEvent extends Event {
  channel: string;
  args: unknown[];
}

/** found-in-page 事件 payload。 */
export interface BrowserWebviewFoundInPageEvent extends Event {
  result: {
    activeMatchOrdinal: number;
    matches: number;
  };
  requestId: number;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: BrowserWebviewElement;
  }
}
