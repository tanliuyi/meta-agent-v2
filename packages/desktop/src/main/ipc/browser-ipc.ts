import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import type { BrowserSessionIdentity } from "../../shared/browser-contracts.ts";
import type {
  BrowserContactInput,
  BrowserPasswordInput,
  BrowserSitePermissionInput,
} from "../../shared/browser-data-contracts.ts";
import { parseBrowserInternalPage } from "../../shared/browser-internal-contracts.ts";
import type { SaveBrowserSettingsInput } from "../../shared/browser-settings-contracts.ts";
import { CHANNELS } from "../../shared/channels.ts";
import type { BrowserManager } from "../browser/browser-manager.ts";

/** 浏览器领域 IPC 的最小依赖。 */
export interface BrowserIpcDependencies {
  readonly browser?: BrowserManager;
}

/** 浏览器 registrar 可能注册的 channel 清单。 */
export const BROWSER_IPC_CHANNELS = [
  CHANNELS.browserAttach,
  CHANNELS.browserDetach,
  CHANNELS.browserTabSelect,
  CHANNELS.browserNavigate,
  CHANNELS.browserScreenshot,
  CHANNELS.browserCopyScreenshot,
  CHANNELS.browserSnapshot,
  CHANNELS.browserAction,
  CHANNELS.browserTabsList,
  CHANNELS.browserSettingsGet,
  CHANNELS.browserSettingsSave,
  CHANNELS.browserSessionRetire,
  CHANNELS.browserSessionAcquire,
  CHANNELS.browserClearData,
  CHANNELS.browserClearAllData,
  CHANNELS.browserHistory,
  CHANNELS.browserOpenDownloads,
  CHANNELS.browserAnnotationPick,
  CHANNELS.browserAnnotationAdd,
  CHANNELS.browserAnnotationList,
  CHANNELS.browserAnnotationRemove,
  CHANNELS.browserAnnotationRemoveMany,
  CHANNELS.browserAnnotationUpdate,
  CHANNELS.browserAnnotationResolve,
  CHANNELS.browserDataGet,
  CHANNELS.browserHistoryDelete,
  CHANNELS.browserHistoryClear,
  CHANNELS.browserDownloadsClear,
  CHANNELS.browserDownloadReveal,
  CHANNELS.browserDownloadOpen,
  CHANNELS.browserContactSave,
  CHANNELS.browserContactDelete,
  CHANNELS.browserPasswordSave,
  CHANNELS.browserPasswordDelete,
  CHANNELS.browserSitePermissionSave,
  CHANNELS.browserSitePermissionDelete,
  CHANNELS.browserPasswordOfferResolve,
] as const;

/** 注册浏览器会话、页面操作、数据和 annotation IPC。 */
export function registerBrowserIpc({ browser }: BrowserIpcDependencies): readonly string[] {
  if (!browser) return [];
  const ownerWebContents = new Set<number>();
  ipcMain.handle(
    CHANNELS.browserAttach,
    (_event, identity: BrowserSessionIdentity, webContentsId: number, requestId?: number) =>
      browser.attach(identity, webContentsId, requestId),
  );
  ipcMain.handle(CHANNELS.browserDetach, (_event, identity: BrowserSessionIdentity, webContentsId: number) =>
    browser.detach(identity, webContentsId),
  );
  ipcMain.handle(CHANNELS.browserTabSelect, (_event, identity: BrowserSessionIdentity, tabId: number) =>
    browser.selectTab(identity, tabId),
  );
  ipcMain.handle(CHANNELS.browserNavigate, (_event, identity: BrowserSessionIdentity, tabId: number, url: string) =>
    browser.navigate(identity, tabId, url),
  );
  ipcMain.handle(CHANNELS.browserScreenshot, (_event, identity: BrowserSessionIdentity, tabId: number) =>
    browser.screenshot(identity, tabId),
  );
  ipcMain.handle(CHANNELS.browserCopyScreenshot, (_event, identity: BrowserSessionIdentity, tabId: number) =>
    browser.copyScreenshot(identity, tabId),
  );
  ipcMain.handle(
    CHANNELS.browserSnapshot,
    (_event, identity: BrowserSessionIdentity, tabId: number, opts?: { withScreenshot?: boolean }) =>
      browser.snapshot(identity, tabId, opts),
  );
  ipcMain.handle(CHANNELS.browserAction, (_event, identity: BrowserSessionIdentity, tabId: number, action) =>
    browser.action(identity, tabId, action),
  );
  ipcMain.handle(CHANNELS.browserTabsList, (_event, identity: BrowserSessionIdentity) => browser.tabsList(identity));
  ipcMain.handle(CHANNELS.browserSettingsGet, () => browser.getSettingsSnapshot());
  ipcMain.handle(CHANNELS.browserSettingsSave, (_event, input: SaveBrowserSettingsInput) =>
    browser.saveSettings(input),
  );
  ipcMain.handle(CHANNELS.browserSessionRetire, (event, identity: BrowserSessionIdentity) =>
    browser.retireSession(identity, event.sender.id),
  );
  ipcMain.handle(CHANNELS.browserSessionAcquire, (event, identity: BrowserSessionIdentity) => {
    const ownerId = event.sender.id;
    if (!ownerWebContents.has(ownerId)) {
      ownerWebContents.add(ownerId);
      event.sender.once("destroyed", () => {
        ownerWebContents.delete(ownerId);
        browser.releaseOwner(ownerId);
      });
    }
    browser.acquireSession(identity, ownerId);
  });
  ipcMain.handle(CHANNELS.browserClearData, (_event, identity: BrowserSessionIdentity) =>
    browser.clearSessionData(identity),
  );
  ipcMain.handle(CHANNELS.browserClearAllData, () => browser.clearAllData());
  ipcMain.handle(CHANNELS.browserHistory, (_event, identity: BrowserSessionIdentity) =>
    browser.browserHistory(identity),
  );
  ipcMain.handle(CHANNELS.browserOpenDownloads, async () => {
    const error = await shell.openPath(app.getPath("downloads"));
    return error ? { ok: false as const, error } : { ok: true as const };
  });
  ipcMain.handle(
    CHANNELS.browserAnnotationPick,
    (_event, identity: BrowserSessionIdentity, tabId: number, x: number, y: number) =>
      browser.pickAnnotationTarget(identity, tabId, x, y),
  );
  ipcMain.handle(CHANNELS.browserAnnotationAdd, (_event, identity: BrowserSessionIdentity, tabId: number, input) =>
    browser.addAnnotation(identity, tabId, input),
  );
  ipcMain.handle(CHANNELS.browserAnnotationList, (_event, identity: BrowserSessionIdentity, tabId: number) =>
    browser.listAnnotations(identity, tabId),
  );
  ipcMain.handle(
    CHANNELS.browserAnnotationRemove,
    (_event, identity: BrowserSessionIdentity, tabId: number, id: string) =>
      browser.removeAnnotation(identity, tabId, id),
  );
  ipcMain.handle(CHANNELS.browserAnnotationRemoveMany, (_event, identity: BrowserSessionIdentity, ids: string[]) =>
    browser.removeAnnotations(identity, ids),
  );
  ipcMain.handle(
    CHANNELS.browserAnnotationUpdate,
    (_event, identity: BrowserSessionIdentity, tabId: number, id: string, input) =>
      browser.updateAnnotation(identity, tabId, id, input),
  );
  ipcMain.handle(
    CHANNELS.browserAnnotationResolve,
    (_event, identity: BrowserSessionIdentity, tabId: number, id: string) =>
      browser.resolveAnnotationBounds(identity, tabId, id),
  );
  ipcMain.handle(CHANNELS.browserDataGet, (event, includePasswords?: boolean) =>
    trustedRequest(event, () => browser.browserDataGet(includePasswords === true)),
  );
  ipcMain.handle(CHANNELS.browserHistoryDelete, (event, url: string, timestamp: number) =>
    trustedRequest(event, () => browser.browserHistoryDelete(url, timestamp)),
  );
  ipcMain.handle(CHANNELS.browserHistoryClear, (event) => trustedRequest(event, () => browser.browserHistoryClear()));
  ipcMain.handle(CHANNELS.browserDownloadsClear, (event) =>
    trustedRequest(event, () => browser.browserDownloadsClear()),
  );
  ipcMain.handle(CHANNELS.browserDownloadReveal, (event, path: string) =>
    trustedRequest(event, () => browser.browserDownloadReveal(path)),
  );
  ipcMain.handle(CHANNELS.browserDownloadOpen, (event, path: string) =>
    trustedRequest(event, () => browser.browserDownloadOpen(path)),
  );
  ipcMain.handle(
    CHANNELS.browserContactSave,
    (event, input: { contactId: string | null; contact: BrowserContactInput }) =>
      trustedRequest(event, () => browser.browserContactSave(input)),
  );
  ipcMain.handle(CHANNELS.browserContactDelete, (event, id: string) =>
    trustedRequest(event, () => browser.browserContactDelete(id)),
  );
  ipcMain.handle(
    CHANNELS.browserPasswordSave,
    (event, input: { passwordId: string | null; password: BrowserPasswordInput }) =>
      trustedRequest(event, () => browser.browserPasswordSave(input)),
  );
  ipcMain.handle(CHANNELS.browserPasswordDelete, (event, id: string) =>
    trustedRequest(event, () => browser.browserPasswordDelete(id)),
  );
  ipcMain.handle(CHANNELS.browserSitePermissionSave, (event, input: BrowserSitePermissionInput) =>
    trustedRequest(event, () => browser.browserSitePermissionSave(input)),
  );
  ipcMain.handle(CHANNELS.browserSitePermissionDelete, (event, id: string) =>
    trustedRequest(event, () => browser.browserSitePermissionDelete(id)),
  );
  ipcMain.handle(
    CHANNELS.browserPasswordOfferResolve,
    (event, identity: BrowserSessionIdentity, offerId: string, save: boolean) =>
      browser.browserPasswordOfferResolve(identity, offerId, save, event.sender.id),
  );
  return BROWSER_IPC_CHANNELS;
}

function trustedRequest<T>(event: IpcMainInvokeEvent, request: () => T): T {
  const isMainRenderer =
    Boolean(BrowserWindow.fromWebContents(event.sender)) && event.senderFrame === event.sender.mainFrame;
  const isInternalPage = parseBrowserInternalPage(event.senderFrame?.url) !== null;
  if (!isMainRenderer && !isInternalPage) throw new Error("拒绝非受信页面访问浏览器内部数据");
  return request();
}
