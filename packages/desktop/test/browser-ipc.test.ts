import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
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

describe("browser IPC", () => {
  const dirtyGuard = { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() };
  const browser = {
    attach: vi.fn(),
    detach: vi.fn(),
    selectTab: vi.fn(),
    navigate: vi.fn(),
    screenshot: vi.fn(),
    snapshot: vi.fn(),
    action: vi.fn(),
    tabsList: vi.fn(),
    getSettingsSnapshot: vi.fn(),
    saveSettings: vi.fn(),
    clearData: vi.fn(),
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
    expect(electron.handles.has(CHANNELS.browserSnapshot)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAction)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserTabsList)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserSettingsGet)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserSettingsSave)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserClearData)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserHistory)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationPick)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationAdd)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationList)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationRemove)).toBe(true);
    expect(electron.handles.has(CHANNELS.browserAnnotationResolve)).toBe(true);
  });

  test("attach 透传 webContentsId 与 requestId 并返回结果", async () => {
    const tab = { tabId: 1, url: "about:blank", title: "", loading: false, crashed: false };
    browser.attach.mockResolvedValue({ ok: true, tab });

    await expect(electron.handles.get(CHANNELS.browserAttach)?.({}, 42, 7)).resolves.toEqual({ ok: true, tab });
    expect(browser.attach).toHaveBeenCalledWith(42, 7);
  });

  test("detach 透传 webContentsId", async () => {
    await electron.handles.get(CHANNELS.browserDetach)?.({}, 42);
    expect(browser.detach).toHaveBeenCalledWith(42);
  });

  test("selectTab 透传 tabId 并返回 tab", () => {
    const tab = { tabId: 3, url: "https://example.com", title: "Example", loading: false, crashed: false };
    browser.selectTab.mockReturnValue(tab);

    const result = electron.handles.get(CHANNELS.browserTabSelect)?.({}, 3);
    expect(result).toBe(tab);
    expect(browser.selectTab).toHaveBeenCalledWith(3);
  });

  test("navigate 透传 tabId 与 url", async () => {
    browser.navigate.mockResolvedValue({ ok: true, tab: { tabId: 1, url: "https://example.com/" } });

    await expect(
      electron.handles.get(CHANNELS.browserNavigate)?.({}, 1, "https://example.com/"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(browser.navigate).toHaveBeenCalledWith(1, "https://example.com/");
  });

  test("screenshot 透传 tabId", async () => {
    browser.screenshot.mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 });

    await expect(electron.handles.get(CHANNELS.browserScreenshot)?.({}, 1)).resolves.toMatchObject({ ok: true });
    expect(browser.screenshot).toHaveBeenCalledWith(1);
  });

  test("snapshot/action/tabsList 透传", async () => {
    browser.snapshot.mockResolvedValue({ ok: true, snapshot: { url: "https://example.com/" } });
    browser.action.mockResolvedValue({ ok: true });
    browser.tabsList.mockResolvedValue([]);

    await expect(
      electron.handles.get(CHANNELS.browserSnapshot)?.({}, 1, { withScreenshot: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      electron.handles.get(CHANNELS.browserAction)?.({}, 1, { type: "click", elementIndex: 2 }),
    ).resolves.toMatchObject({ ok: true });
    await expect(electron.handles.get(CHANNELS.browserTabsList)?.({})).resolves.toEqual([]);

    expect(browser.snapshot).toHaveBeenCalledWith(1, { withScreenshot: true });
    expect(browser.action).toHaveBeenCalledWith(1, { type: "click", elementIndex: 2 });
    expect(browser.tabsList).toHaveBeenCalledOnce();
  });

  test("设置读写与清数据透传", async () => {
    const snapshot = { revision: "one", settings: {} };
    const saveInput = { expectedRevision: "one", settings: {} };
    browser.getSettingsSnapshot.mockResolvedValue(snapshot);
    browser.saveSettings.mockResolvedValue({ status: "saved", snapshot });
    browser.clearData.mockResolvedValue(undefined);

    await expect(electron.handles.get(CHANNELS.browserSettingsGet)?.({})).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.browserSettingsSave)?.({}, saveInput)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    await electron.handles.get(CHANNELS.browserClearData)?.({});
    expect(browser.getSettingsSnapshot).toHaveBeenCalledOnce();
    expect(browser.saveSettings).toHaveBeenCalledWith(saveInput);
    expect(browser.clearData).toHaveBeenCalledOnce();
  });

  test("历史与标注通道透传", async () => {
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

    await expect(electron.handles.get(CHANNELS.browserHistory)?.({})).resolves.toEqual([entry]);
    await expect(electron.handles.get(CHANNELS.browserAnnotationPick)?.({}, 1, 10, 20)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      electron.handles.get(CHANNELS.browserAnnotationAdd)?.({}, 1, { selector: "#a", tag: "button" }),
    ).resolves.toMatchObject({ id: "n1" });
    await expect(electron.handles.get(CHANNELS.browserAnnotationList)?.({}, 1)).resolves.toEqual([]);
    await electron.handles.get(CHANNELS.browserAnnotationRemove)?.({}, 1, "n1");
    await expect(electron.handles.get(CHANNELS.browserAnnotationResolve)?.({}, 1, "n1")).resolves.toEqual({
      x: 5,
      y: 6,
      width: 3,
      height: 4,
    });

    expect(browser.browserHistory).toHaveBeenCalledOnce();
    expect(browser.pickAnnotationTarget).toHaveBeenCalledWith(1, 10, 20);
    expect(browser.addAnnotation).toHaveBeenCalledWith(1, { selector: "#a", tag: "button" });
    expect(browser.listAnnotations).toHaveBeenCalledWith(1);
    expect(browser.removeAnnotation).toHaveBeenCalledWith(1, "n1");
    expect(browser.resolveAnnotationBounds).toHaveBeenCalledWith(1, "n1");
  });
});
