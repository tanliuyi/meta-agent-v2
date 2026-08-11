import { contextBridge, ipcRenderer } from "electron";
import type { BrowserInternalApi } from "../shared/browser-internal-contracts.ts";

// Sandbox preload 必须是单文件，不能运行时 require Rollup shared chunks。
// 这些字面量与 shared/channels.ts 的主进程注册点保持一一对应。
const INTERNAL_CHANNELS = {
  dataGet: "desktop:browser:data-get",
  historyDelete: "desktop:browser:history-delete",
  historyClear: "desktop:browser:history-clear",
  downloadsClear: "desktop:browser:downloads-clear",
  openDownloads: "desktop:browser:open-downloads",
  downloadReveal: "desktop:browser:download-reveal",
  downloadOpen: "desktop:browser:download-open",
  contactSave: "desktop:browser:contact-save",
  contactDelete: "desktop:browser:contact-delete",
  passwordSave: "desktop:browser:password-save",
  passwordDelete: "desktop:browser:password-delete",
  sitePermissionSave: "desktop:browser:site-permission-save",
  sitePermissionDelete: "desktop:browser:site-permission-delete",
  host: "browser-internal-host",
} as const;

const browserInternalApi: BrowserInternalApi = {
  dataGet: (includePasswords) => ipcRenderer.invoke(INTERNAL_CHANNELS.dataGet, includePasswords),
  historyDelete: (url, timestamp) => ipcRenderer.invoke(INTERNAL_CHANNELS.historyDelete, url, timestamp),
  historyClear: () => ipcRenderer.invoke(INTERNAL_CHANNELS.historyClear),
  downloadsClear: () => ipcRenderer.invoke(INTERNAL_CHANNELS.downloadsClear),
  openDownloads: () => ipcRenderer.invoke(INTERNAL_CHANNELS.openDownloads),
  downloadReveal: (path) => ipcRenderer.invoke(INTERNAL_CHANNELS.downloadReveal, path),
  downloadOpen: (path) => ipcRenderer.invoke(INTERNAL_CHANNELS.downloadOpen, path),
  contactSave: (input) => ipcRenderer.invoke(INTERNAL_CHANNELS.contactSave, input),
  contactDelete: (id) => ipcRenderer.invoke(INTERNAL_CHANNELS.contactDelete, id),
  passwordSave: (input) => ipcRenderer.invoke(INTERNAL_CHANNELS.passwordSave, input),
  passwordDelete: (id) => ipcRenderer.invoke(INTERNAL_CHANNELS.passwordDelete, id),
  sitePermissionSave: (input) => ipcRenderer.invoke(INTERNAL_CHANNELS.sitePermissionSave, input),
  sitePermissionDelete: (id) => ipcRenderer.invoke(INTERNAL_CHANNELS.sitePermissionDelete, id),
  openUrl: (url) => ipcRenderer.sendToHost(INTERNAL_CHANNELS.host, { type: "open-url", url }),
};

contextBridge.exposeInMainWorld("browserInternal", browserInternalApi);
