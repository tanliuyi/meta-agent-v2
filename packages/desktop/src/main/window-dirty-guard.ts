import { type BrowserWindow, dialog } from "electron";

interface PreventableEvent {
  preventDefault(): void;
}

type GuardAction = "close" | "reload";

interface WindowDirtyGuardOptions {
  confirm?(window: BrowserWindow): Promise<boolean>;
}

/** Coordinates one native discard prompt across every main-owned destructive window action. */
export class WindowDirtyGuard {
  private readonly dirtyWebContents = new Set<number>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly bypass = new Map<number, GuardAction>();
  private readonly confirm: (window: BrowserWindow) => Promise<boolean>;
  private quitConfirmed = false;
  private quitPrompt: Promise<boolean> | undefined;

  constructor(options: WindowDirtyGuardOptions = {}) {
    this.confirm = options.confirm ?? showDiscardConfirmation;
  }

  setDirty(webContentsId: number, dirty: boolean): void {
    if (dirty) this.dirtyWebContents.add(webContentsId);
    else this.dirtyWebContents.delete(webContentsId);
  }

  remove(webContentsId: number): void {
    this.dirtyWebContents.delete(webContentsId);
    this.pending.delete(webContentsId);
    this.bypass.delete(webContentsId);
  }

  isDirty(webContentsId: number): boolean {
    return this.dirtyWebContents.has(webContentsId);
  }

  hasDirtyWindows(windows: readonly BrowserWindow[]): boolean {
    return windows.some((window) => !window.isDestroyed() && this.isDirty(window.webContents.id));
  }

  attach(window: BrowserWindow): void {
    window.on("close", (event) => this.handleCloseEvent(window, event));
    window.webContents.once("destroyed", () => this.remove(window.webContents.id));
  }

  handleCloseEvent(window: BrowserWindow, event: PreventableEvent): void {
    if (this.quitConfirmed) return;
    const id = window.webContents.id;
    if (this.consumeBypass(id, "close") || !this.isDirty(id)) return;
    event.preventDefault();
    void this.request(window, "close");
  }

  requestClose(window: BrowserWindow): Promise<void> {
    return this.request(window, "close");
  }

  requestReload(window: BrowserWindow): Promise<void> {
    return this.request(window, "reload");
  }

  async confirmApplicationQuit(windows: readonly BrowserWindow[]): Promise<boolean> {
    if (this.quitConfirmed) return true;
    const dirtyWindow = windows.find((window) => !window.isDestroyed() && this.isDirty(window.webContents.id));
    if (!dirtyWindow) return true;
    if (!this.quitPrompt) {
      this.quitPrompt = this.confirm(dirtyWindow).then((confirmed) => {
        if (confirmed) this.quitConfirmed = true;
        return confirmed;
      });
    }
    try {
      return await this.quitPrompt;
    } finally {
      this.quitPrompt = undefined;
    }
  }

  isApplicationQuitConfirmed(): boolean {
    return this.quitConfirmed;
  }

  private request(window: BrowserWindow, action: GuardAction): Promise<void> {
    if (window.isDestroyed()) return Promise.resolve();
    const id = window.webContents.id;
    if (!this.isDirty(id)) {
      this.perform(window, action);
      return Promise.resolve();
    }
    const existing = this.pending.get(id);
    if (existing) return existing;
    const operation = this.confirm(window)
      .then((confirmed) => {
        if (!confirmed || window.isDestroyed()) return;
        this.bypass.set(id, action);
        this.perform(window, action);
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, operation);
    return operation;
  }

  private perform(window: BrowserWindow, action: GuardAction): void {
    if (action === "close") window.close();
    else window.webContents.reload();
  }

  private consumeBypass(webContentsId: number, action: GuardAction): boolean {
    if (this.bypass.get(webContentsId) !== action) return false;
    this.bypass.delete(webContentsId);
    return true;
  }
}

async function showDiscardConfirmation(window: BrowserWindow): Promise<boolean> {
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["取消", "放弃"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "放弃未保存的模型配置吗？",
    detail: "未保存的修改将丢失。",
  });
  return result.response === 1;
}
