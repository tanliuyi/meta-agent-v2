import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import type { BrowserSessionIdentity } from "../src/shared/browser-contracts.ts";
import { CHANNELS } from "../src/shared/channels.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

const IDENTITY: BrowserSessionIdentity = { projectId: "proj-a", threadId: "thread-a" };

describe("browser IPC", () => {
  const dirtyGuard = { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() };
  const browser = {
    attach: vi.fn(),
    detach: vi.fn(),
    selectTab: vi.fn(),
    navigate: vi.fn(),
    screenshot: vi.fn(),
    copyScreenshot: vi.fn(),
    snapshot: vi.fn(),
    action: vi.fn(),
    tabsList: vi.fn(),
    getSettingsSnapshot: vi.fn(),
    saveSettings: vi.fn(),
    retireSession: vi.fn(),
    clearSessionData: vi.fn(),
    clearAllData: vi.fn(),
    browserHistory: vi.fn(),
    pickAnnotationTarget: vi.fn(),
    addAnnotation: vi.fn(),
    listAnnotations: vi.fn(),
    removeAnnotation: vi.fn(),
    resolveAnnotationBounds: vi.fn(),
  };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
    registerIpc(
      { list: vi.fn(), getActive: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { disposeProject: vi.fn(), disposeSession: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dirtyGuard as never,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      browser as never,
    );
  });

  test("注册全部 browser 处理器", () => {
    expect(electron.handles.has(CHANNELS.browserAttach)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserDetach)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserTabSelect)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserNavigate)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserScreenshot)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserCopyScreenshot)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserSnapshot)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAction)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserTabsList)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserSettingsGet)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserSettingsSave)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserSessionRetire)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserClearData)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserClearAllData)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserHistory)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationPick)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationAdd)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationList)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationRemove)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationResolve)).toBe(true);
  });

  test("attach 透传会话身份、webContentsId 与 requestId 并返回结果", async () => {
    const tab = { tabId: 1, url: "about:blank", title: "", loading: false, crashed: false };
    browser.attach.mockResolvedValue({ ok: true, tab });

    await expect(electron.handles.get(CHANNELS.browserAttach)?.({}, IDENTITY, 42, 7)).resolves.toEqual({
      ok: true,
      tab,
    });
    expect(browser.attach).toHaveBeenCalledWith(IDENTITY, 42, 7);
  });

  test("detach 透传会话身份与 webContentsId", async () => {
    await electron.handles.get(CHANNELS.browserDetach)?.({}, IDENTITY, 42);
    expect(browser.detach).toHaveBeenCalledWith(IDENTITY, 42);
  });

  test("selectTab 透传会话身份与 tabId 并返回 tab", () => {
    const tab = { tabId: 3, url: "https://example.com", title: "Example", loading: false, crashed: false };
    browser.selectTab.mockReturnValue(tab);

    const result = electron.handles.get(CHANNELS.browserTabSelect)?.({}, IDENTITY, 3);
    expect(result).toBe(tab);
    expect(browser.selectTab).toHaveBeenCalledWith(IDENTITY, 3);
  });

  test("navigate 透传会话身份、tabId 与 url", async () => {
    browser.navigate.mockResolvedValue({ ok: true, tab: { tabId: 1, url: "https://example.com/" } });

    await expect(
      electron.handles.get(CHANNELS.browserNavigate)?.({}, IDENTITY, 1, "https://example.com/"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(browser.navigate).toHaveBeenCalledWith(IDENTITY, 1, "https://example.com/");
  });

  test("screenshot 透传会话身份与 tabId", async () => {
    browser.screenshot.mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 });

    await expect(electron.handles.get(CHANNELS.browserScreenshot)?.({}, IDENTITY, 1)).resolves.toMatchObject({
      ok: true,
    });
    expect(browser.screenshot).toHaveBeenCalledWith(IDENTITY, 1);
  });

  test("copyScreenshot 透传会话身份与 tabId", async () => {
    browser.copyScreenshot.mockResolvedValue({ ok: true });

    await expect(electron.handles.get(CHANNELS.browserCopyScreenshot)?.({}, IDENTITY, 1)).resolves.toEqual({
      ok: true,
    });
    expect(browser.copyScreenshot).toHaveBeenCalledWith(IDENTITY, 1);
  });

  test("snapshot/action/tabsList 透传会话身份", async () => {
    browser.snapshot.mockResolvedValue({ ok: true, snapshot: { url: "https://example.com/" } });
    browser.action.mockResolvedValue({ ok: true });
    browser.tabsList.mockResolvedValue([]);

    await expect(
      electron.handles.get(CHANNELS.browserSnapshot)?.({}, IDENTITY, 1, { withScreenshot: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      electron.handles.get(CHANNELS.browserAction)?.({}, IDENTITY, 1, { type: "click", elementIndex: 2 }),
    ).resolves.toMatchObject({ ok: true });
    await expect(electron.handles.get(CHANNELS.browserTabsList)?.({}, IDENTITY)).resolves.toEqual([]);

    expect(browser.snapshot).toHaveBeenCalledWith(IDENTITY, 1, { withScreenshot: true });
    expect(browser.action).toHaveBeenCalledWith(IDENTITY, 1, { type: "click", elementIndex: 2 });
    expect(browser.tabsList).toHaveBeenCalledWith(IDENTITY);
  });

  test("设置读写透传（全局，无身份）", async () => {
    const snapshot = { revision: "one", settings: {} };
    const saveInput = { expectedRevision: "one", settings: {} };
    browser.getSettingsSnapshot.mockResolvedValue(snapshot);
    browser.saveSettings.mockResolvedValue({ status: "saved", snapshot });

    await expect(electron.handles.get(CHANNELS.browserSettingsGet)?.({})).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.browserSettingsSave)?.({}, saveInput)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    expect(browser.getSettingsSnapshot).toHaveBeenCalledOnce();
    expect(browser.saveSettings).toHaveBeenCalledWith(saveInput);
  });

  test("会话退役/清数据/全量清数据透传会话身份", async () => {
    await electron.handles.get(CHANNELS.browserSessionRetire)?.({}, IDENTITY);
    await electron.handles.get(CHANNELS.browserClearData)?.({}, IDENTITY);
    await electron.handles.get(CHANNELS.browserClearAllData)?.({});
    expect(browser.retireSession).toHaveBeenCalledWith(IDENTITY);
    expect(browser.clearSessionData).toHaveBeenCalledWith(IDENTITY);
    expect(browser.clearAllData).toHaveBeenCalledOnce();
  });

  test("历史与标注通道透传会话身份", async () => {
    const entry = { url: "https://example.com/", title: "Example", timestamp: 1 };
    browser.browserHistory.mockResolvedValue([entry]);
    browser.pickAnnotationTarget.mockResolvedValue({
      ok: true,
      selector: "#a",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      tag: "button",
      name: "A",
    });
    browser.addAnnotation.mockResolvedValue({
      id: "n1",
      tabId: 1,
      selector: "#a",
      tag: "button",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      text: "改",
      createdAt: 1,
    });
    browser.listAnnotations.mockResolvedValue([]);
    browser.removeAnnotation.mockResolvedValue(undefined);
    browser.resolveAnnotationBounds.mockResolvedValue({ x: 5, y: 6, width: 3, height: 4 });

    await expect(electron.handles.get(CHANNELS.browserHistory)?.({}, IDENTITY)).resolves.toEqual([entry]);
    await expect(
      electron.handles.get(CHANNELS.browserAnnotationPick)?.({}, IDENTITY, 1, 10, 20),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      electron.handles.get(CHANNELS.browserAnnotationAdd)?.({}, IDENTITY, 1, { selector: "#a", tag: "button" }),
    ).resolves.toMatchObject({ id: "n1" });
    await expect(electron.handles.get(CHANNELS.browserAnnotationList)?.({}, IDENTITY, 1)).resolves.toEqual([]);
    await electron.handles.get(CHANNELS.browserAnnotationRemove)?.({}, IDENTITY, 1, "n1");
    await expect(electron.handles.get(CHANNELS.browserAnnotationResolve)?.({}, IDENTITY, 1, "n1")).resolves.toEqual({
      x: 5,
      y: 6,
      width: 3,
      height: 4,
    });

    expect(browser.browserHistory).toHaveBeenCalledWith(IDENTITY);
    expect(browser.pickAnnotationTarget).toHaveBeenCalledWith(IDENTITY, 1, 10, 20);
    expect(browser.addAnnotation).toHaveBeenCalledWith(IDENTITY, 1, { selector: "#a", tag: "button" });
    expect(browser.listAnnotations).toHaveBeenCalledWith(IDENTITY, 1);
    expect(browser.removeAnnotation).toHaveBeenCalledWith(IDENTITY, 1, "n1");
    expect(browser.resolveAnnotationBounds).toHaveBeenCalledWith(IDENTITY, 1, "n1");
  });
});
