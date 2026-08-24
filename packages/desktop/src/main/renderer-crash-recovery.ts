import { type BrowserWindow, dialog, type RenderProcessGoneDetails } from "electron";

type CrashRecoveryAction = "reload" | "quit";

interface RendererCrashRecoveryOptions {
  isShuttingDown(): boolean;
  reload(window: BrowserWindow): void;
  quit(window: BrowserWindow): void;
  report(message: string, error?: unknown): void;
  prompt?(window: BrowserWindow, details: RenderProcessGoneDetails): Promise<CrashRecoveryAction>;
}

const reasonLabels: Record<RenderProcessGoneDetails["reason"], string> = {
  "clean-exit": "渲染进程意外退出",
  "abnormal-exit": "渲染进程异常退出",
  killed: "渲染进程被终止",
  crashed: "渲染进程崩溃",
  oom: "应用内存不足",
  "launch-failed": "渲染进程启动失败",
  "integrity-failure": "渲染进程完整性检查失败",
  "memory-eviction": "渲染进程因系统内存压力被回收",
};

/** Reports main-window renderer failures through native UI that survives renderer crashes. */
export function attachRendererCrashRecovery(window: BrowserWindow, options: RendererCrashRecoveryOptions): () => void {
  let handling = false;
  const prompt = options.prompt ?? showCrashPrompt;
  const webContents = window.webContents;

  const handleCrash = (_event: Electron.Event, details: RenderProcessGoneDetails): void => {
    if (handling || options.isShuttingDown() || window.isDestroyed()) return;
    handling = true;
    options.report(`Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);

    void prompt(window, details)
      .then((action) => {
        if (window.isDestroyed() || options.isShuttingDown()) return;
        if (action === "reload") options.reload(window);
        else options.quit(window);
      })
      .catch((error: unknown) => {
        options.report("Failed to show renderer crash dialog; reloading the window", error);
        if (!window.isDestroyed() && !options.isShuttingDown()) options.reload(window);
      })
      .finally(() => {
        handling = false;
      });
  };

  webContents.on("render-process-gone", handleCrash);
  return () => {
    if (!webContents.isDestroyed()) webContents.off("render-process-gone", handleCrash);
  };
}

async function showCrashPrompt(window: BrowserWindow, details: RenderProcessGoneDetails): Promise<CrashRecoveryAction> {
  const result = await dialog.showMessageBox(window, {
    type: "error",
    buttons: ["重新加载", "退出应用"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: "Meta Agent 已停止响应",
    message: reasonLabels[details.reason],
    detail: `工作台渲染进程已停止，未保存的界面状态可能丢失。\n错误原因：${details.reason}（退出码 ${details.exitCode}）`,
  });
  return result.response === 0 ? "reload" : "quit";
}
