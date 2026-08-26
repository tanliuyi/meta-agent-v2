import {
  readCssFontSizePx,
  readCssToken,
  resolveTerminalTheme,
  TERMINAL_FONT_SIZE_TOKEN,
  TERMINAL_FONT_TOKEN,
} from "@renderer/shared/lib/terminal-theme";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalEvent } from "../../../../../shared/contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { useFont } from "../../../state/font.tsx";
import { useTheme } from "../../../state/theme.tsx";
import { useSessionScope } from "../../session-context.tsx";
import { createCommandDecorationManager } from "./terminal-command-decorations.ts";
import { attachVisualCursorImeAnchor, constrainTerminalComposition } from "./terminal-composition.ts";
import { registerTerminalLinkProviders } from "./terminal-links.ts";
import { TerminalOutputQueue } from "./terminal-output-queue.ts";
import { shouldUseWebglRenderer } from "./terminal-renderer.ts";
import { TerminalSearchBar } from "./terminal-search-bar.tsx";
import { TerminalStartupBuffer } from "./terminal-startup-buffer.ts";
import { MouseWheelClassifier } from "./terminal-wheel-classifier.ts";

export interface TerminalViewHandle {
  restart(): Promise<void>;
}

/** 状态徽标语义：running 不渲染徽标；exited/error 按 data-kind 区分配色。 */
type TerminalStatus = { kind: "running" | "exited" | "error"; message: string } | null;

/**
 * WebGL 渲染器一旦加载失败就全局降级 DOM renderer（对应 VS Code 的
 * _suggestedRendererType="dom"），避免每个终端重复尝试创建 WebGL context。
 */
let webglRenderFailed = false;

/** 将当前 session 的 PTY 快照与增量事件渲染到 xterm。 */
export const TerminalView = forwardRef<TerminalViewHandle, { terminalId: string }>(function TerminalView(
  { terminalId },
  ref,
) {
  const { record } = useSessionScope();
  const { projectId, threadId } = record.identity;
  const { resolvedTheme } = useTheme();
  const { fontSize: uiFontSize } = useFont();
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const outputQueueRef = useRef<TerminalOutputQueue | null>(null);
  const syncSizeRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const revision = useRef(0);
  const [status, setStatus] = useState<TerminalStatus>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  /** 复制当前选区到系统剪贴板（Electron 环境 navigator.clipboard 可用）。 */
  const copySelection = () => {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return;
    void navigator.clipboard.writeText(selection).catch(() => {});
  };

  /**
   * 粘贴文本；含换行且 shell 未启用 bracketed paste 时先确认（对齐 VS Code
   * enableMultiLinePasteWarning 的 auto 语义：bracketed paste 说明 shell 原生支持多行粘贴）。
   */
  const pasteText = async (text: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (text.includes("\n") && !terminal.modes.bracketedPasteMode) {
      const confirmed = window.confirm("粘贴内容包含多行，确认要粘贴到终端吗？");
      if (!confirmed) return;
    }
    terminal.paste(text);
  };

  /** 从系统剪贴板粘贴；读取受限时回退到 textarea 的原生粘贴。 */
  const pasteFromClipboard = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    try {
      await pasteText(await navigator.clipboard.readText());
    } catch {
      terminal.textarea?.focus();
      document.execCommand("paste");
    }
  };

  /** 重启当前终端（进程退出后经徽标/句柄触发）。 */
  const restartTerminal = useCallback(async () => {
    const terminal = terminalRef.current;
    if (!projectId || !threadId || !terminal) return;
    const next = await window.desktop.terminals.restart(projectId, threadId, terminalId, terminal.cols, terminal.rows);
    if (next.revision >= revision.current) {
      revision.current = next.revision;
      await outputQueueRef.current?.replace(next.output);
      setStatus(next.running ? null : { kind: "exited", message: "终端进程已退出" });
    }
  }, [projectId, terminalId, threadId]);

  useImperativeHandle(ref, () => ({
    restart: () => restartTerminal(),
  }));

  useEffect(() => {
    if (!projectId || !threadId || !container.current) return;
    let active = true;
    let phase: "opening" | "opened" | "failed" = "opening";
    let webgl: WebglAddon | null = null;
    let image: ImageAddon | null = null;
    const pending = new TerminalStartupBuffer();
    const rootStyle = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      cursorBlink: true,
      // customGlyphs 属于 xterm 6.0 的 Terminal options（WebglAddon 构造仅接受 preserveDrawingBuffer）。
      customGlyphs: true,
      minimumContrastRatio: 4.5,
      // 命令装饰（OSC 633）与 registerDecoration 需要 proposed API。
      allowProposedApi: true,
      // 终端表面始终由主题提供不透明背景；保持 false 让 WebGL glyph atlas 使用实色背景，
      // 避免透明纹理的边缘覆盖率把小字号文字渲染得过细。ImageAddon 自己的图片层仍使用 alpha canvas。
      allowTransparency: false,
      // 右侧滚动条内显示搜索匹配/命令装饰位置（VS Code overviewRuler）。
      overviewRuler: { width: 10 },
      // 平滑滚动初始关闭，wheel 事件经分类器识别为物理滚轮后再启用（VS Code 做法）：
      // 触控板自带平滑，叠加动画会卡顿。
      smoothScrollDuration: 0,
      // 对齐 VS Code 默认：缩放宽度歧义字符，避免覆盖相邻单元格。
      rescaleOverlappingGlyphs: true,
      fontFamily: readCssToken(rootStyle, TERMINAL_FONT_TOKEN),
      fontSize: readCssFontSizePx(rootStyle, TERMINAL_FONT_SIZE_TOKEN),
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      theme: resolveTerminalTheme(rootStyle),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const search = new SearchAddon({ highlightLimit: 2000 });
    terminal.loadAddon(search);
    // Unicode 11 宽度表：emoji/宽字符占位更准确（xterm 默认 Unicode 6）。
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    terminal.open(container.current);
    const output = new TerminalOutputQueue(terminal);
    terminalRef.current = terminal;
    outputQueueRef.current = output;
    searchAddonRef.current = search;
    let resizeFrame: number | undefined;
    let lastGrid: TerminalGrid | undefined;
    // 进程退出后暂停 PTY resize 同步（避免与主进程退出竞态窗口的无效 IPC）。
    let exited = false;
    let lastFitAt = 0;
    let authoritativeSync: Promise<void> | null = null;
    let syncRetryDelayMs = 25;

    function startAuthoritativeSync(): void {
      if (authoritativeSync) return;
      phase = "opening";
      const sync = openFromAuthoritativeSnapshot();
      authoritativeSync = sync;
      void sync.finally(() => {
        if (authoritativeSync === sync) authoritativeSync = null;
      });
    }

    const matches = (event: TerminalEvent) =>
      event.projectId === projectId && event.threadId === threadId && event.terminalId === terminalId;
    const apply = (event: TerminalEvent) => {
      if (event.revision <= revision.current) return;
      revision.current = event.revision;
      if (event.type === "data") {
        if (!output.write(event.data)) {
          pending.clear();
          startAuthoritativeSync();
        }
      } else if (event.type === "reset") {
        pending.clear();
        void output.reset();
        exited = false;
        setStatus(null);
        startAuthoritativeSync();
      } else {
        exited = true;
        setStatus({ kind: "exited", message: `终端进程已退出 (${event.exitCode})` });
      }
    };
    let unsubscribe = (): void => undefined;
    const input = terminal.onData((data) => {
      // 进程退出后拦截输入：不向主进程发送（否则触发 write 错误），重启后自动恢复。
      if (exited) return;
      void window.desktop.terminals
        .write(projectId, threadId, terminalId, data)
        .catch((value: unknown) => setStatus({ kind: "error", message: errorMessage(value) }));
    });
    // 选中即复制（VS Code copyOnSelection）。
    const selectionChange = terminal.onSelectionChange(() => {
      if (terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      }
    });
    const syncSize = () => {
      if (resizeFrame !== undefined) return;
      // fit 节流：窗口拖拽时 ResizeObserver 每帧触发，字体测量是同步 DOM 操作，
      // 80ms 节流把拖拽期间 fit 频率从 60fps 降到 ~12fps（对齐 VS Code terminalResizeDebouncer）。
      const schedule = () => {
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = undefined;
          const now = performance.now();
          if (now - lastFitAt < FIT_THROTTLE_MS) {
            schedule();
            return;
          }
          lastFitAt = now;
          fit.fit();
          if (exited) return;
          const grid = { columns: terminal.cols, rows: terminal.rows };
          if (phase !== "opened" || isSameTerminalGrid(lastGrid, grid)) return;
          lastGrid = grid;
          void window.desktop.terminals
            .resize(projectId, threadId, terminalId, grid.columns, grid.rows)
            .catch((value: unknown) => setStatus({ kind: "error", message: errorMessage(value) }));
        });
      };
      schedule();
    };
    const resize = new ResizeObserver(syncSize);
    resize.observe(container.current);
    syncSizeRef.current = syncSize;
    fit.fit();
    lastGrid = { columns: terminal.cols, rows: terminal.rows };

    // WebGL 渲染优化：加载失败回退 DOM renderer（模块级标记避免每个终端重试）；
    // context 丢失时自动 dispose 回退 DOM renderer。两种切换后 cell 尺寸不同，
    // 必须重新 fit 并同步 PTY 尺寸。
    // xterm WebGL 的 glyph atlas 在非整数 DPR 下需要对 canvas 做小数缩放，
    // 小字号边缘会被纹理采样软化；这类屏幕改用默认 DOM renderer，整数 DPR 仍保留 WebGL 性能。
    const useWebgl = shouldUseWebglRenderer(window.devicePixelRatio);
    if (useWebgl && !webglRenderFailed) {
      try {
        webgl = new WebglAddon();
        terminal.loadAddon(webgl);
      } catch {
        webgl = null;
        webglRenderFailed = true;
      }
    }
    // 图片协议仅 WebGL 下可用（VS Code _refreshImageAddon 同策略）。
    if (webgl) {
      try {
        image = new ImageAddon();
        terminal.loadAddon(image);
      } catch {
        image = null;
      }
    }
    fit.fit();
    syncSize();
    const contextLoss = webgl?.onContextLoss(() => {
      webgl?.dispose();
      webgl = null;
      image?.dispose();
      image = null;
      fit.fit();
      syncSize();
    });

    // 复制/粘贴快捷键：有选区 Ctrl+C 复制并拦截，无选区放行（SIGINT）；
    // Ctrl+Shift+C 复制、Ctrl+Shift+V 粘贴（多行警告）、Ctrl+F 打开搜索。
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "c") {
        if (terminal.hasSelection()) copySelection();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && key === "v") {
        void pasteFromClipboard();
        return false;
      }
      if (event.ctrlKey && key === "c") {
        if (terminal.hasSelection()) {
          copySelection();
          return false;
        }
        return true;
      }
      if (event.ctrlKey && key === "f") {
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    // 右键行为对齐 VS Code Windows 默认（rightClickBehavior: copyPaste）：
    // 有选区右键复制，无选区右键粘贴；preventDefault 阻止系统菜单。
    const element = terminal.element;
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) copySelection();
      else void pasteFromClipboard();
    };
    element?.addEventListener("contextmenu", handleContextMenu);

    // 物理滚轮/触控板分类：仅物理滚轮启用平滑滚动动画（VS Code MouseWheelClassifier）。
    const wheelClassifier = MouseWheelClassifier.INSTANCE;
    let isPhysicalWheel = false;
    const classifyWheel = (event: WheelEvent) => {
      wheelClassifier.acceptStandardWheelEvent(event.deltaX, event.deltaY);
      const physical = wheelClassifier.isPhysicalMouseWheel();
      if (physical !== isPhysicalWheel) {
        isPhysicalWheel = physical;
        terminal.options.smoothScrollDuration = physical ? 125 : 0;
      }
    };
    element?.addEventListener("wheel", classifyWheel, { passive: true });

    // xterm 的 IME 浮层按光标位置向右自然扩展，靠近右边缘时会侵入相邻面板。
    // 在 xterm 完成 compositionupdate 定位后，将浮层向左约束到当前终端表面内。
    const compositionView = element?.querySelector<HTMLElement>(".composition-view");
    let compositionFrame: number | undefined;
    const constrainComposition = () => {
      if (!element || !compositionView || compositionFrame !== undefined) return;
      compositionFrame = requestAnimationFrame(() => {
        compositionFrame = undefined;
        constrainTerminalComposition(element, compositionView);
      });
    };
    const clearCompositionConstraint = () => {
      if (compositionFrame !== undefined) cancelAnimationFrame(compositionFrame);
      compositionFrame = undefined;
      if (compositionView) compositionView.style.transform = "";
    };
    terminal.textarea?.addEventListener("compositionstart", constrainComposition);
    terminal.textarea?.addEventListener("compositionupdate", constrainComposition);
    terminal.textarea?.addEventListener("compositionend", clearCompositionConstraint);
    const visualCursorImeAnchor = attachVisualCursorImeAnchor(terminal);

    // 低配 shell integration：OSC 633 命令边界解析 + 成功/失败装饰。
    const commandDecorations = createCommandDecorationManager(terminal);

    const disposeLinks = registerTerminalLinkProviders(terminal, projectId);

    const openFromAuthoritativeSnapshot = async (): Promise<void> => {
      try {
        while (active) {
          const initial = await window.desktop.terminals.open(
            projectId,
            threadId,
            terminalId,
            terminal.cols,
            terminal.rows,
          );
          if (!active) return;
          const beforeWrite = pending.drain();
          if (beforeWrite.truncated) {
            await waitForTerminalSyncRetry(syncRetryDelayMs);
            syncRetryDelayMs = Math.min(syncRetryDelayMs * 2, 500);
            continue;
          }

          revision.current = initial.revision;
          exited = !initial.running;
          await output.replace(initial.output);
          if (!active) return;

          const afterWrite = pending.drain();
          if (afterWrite.truncated) {
            await waitForTerminalSyncRetry(syncRetryDelayMs);
            syncRetryDelayMs = Math.min(syncRetryDelayMs * 2, 500);
            continue;
          }
          syncRetryDelayMs = 25;
          phase = "opened";
          setStatus(initial.running ? null : { kind: "exited", message: "终端进程已退出" });
          syncSize();
          for (const event of [...beforeWrite.events, ...afterWrite.events]) apply(event);
          return;
        }
      } catch (value: unknown) {
        if (!active) return;
        phase = "failed";
        exited = true;
        pending.clear();
        setStatus({ kind: "error", message: errorMessage(value) });
      }
    };
    unsubscribe = window.desktop.terminals.onEvent((event) => {
      if (!active || !matches(event)) return;
      if (phase === "opening") pending.append(event);
      else if (phase === "opened") apply(event);
    });
    startAuthoritativeSync();

    return () => {
      active = false;
      pending.clear();
      terminalRef.current = null;
      outputQueueRef.current = null;
      output.dispose();
      syncSizeRef.current = null;
      searchAddonRef.current = null;
      resize.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      input.dispose();
      unsubscribe();
      selectionChange.dispose();
      contextLoss?.dispose();
      commandDecorations.dispose();
      disposeLinks();
      element?.removeEventListener("contextmenu", handleContextMenu);
      element?.removeEventListener("wheel", classifyWheel);
      terminal.textarea?.removeEventListener("compositionstart", constrainComposition);
      terminal.textarea?.removeEventListener("compositionupdate", constrainComposition);
      terminal.textarea?.removeEventListener("compositionend", clearCompositionConstraint);
      visualCursorImeAnchor.dispose();
      clearCompositionConstraint();
      image?.dispose();
      webgl?.dispose();
      unicode11.dispose();
      search.dispose();
      fit.dispose();
      terminal.dispose();
    };
  }, [projectId, terminalId, threadId]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(getComputedStyle(document.documentElement));
    }
  }, [resolvedTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const next = readCssFontSizePx(getComputedStyle(document.documentElement), TERMINAL_FONT_SIZE_TOKEN);
    if (terminal.options.fontSize === next) return;
    terminal.options.fontSize = next;
    syncSizeRef.current?.();
  }, [uiFontSize]);

  return (
    <div className="terminal-view">
      <div ref={container} className="terminal-xterm" aria-label="终端" />
      {status ? (
        status.kind === "exited" ? (
          <button
            type="button"
            className="terminal-status"
            data-kind={status.kind}
            title="点击重新启动终端"
            onClick={() => void restartTerminal()}
          >
            {status.message} · 点击重启
          </button>
        ) : (
          <div className="terminal-status" data-kind={status.kind}>
            {status.message}
          </div>
        )
      ) : null}
      {searchOpen && searchAddonRef.current ? (
        <TerminalSearchBar addon={searchAddonRef.current} onClose={() => setSearchOpen(false)} />
      ) : null}
    </div>
  );
});

/** 同步终端尺寸的 fit 节流窗口：拖拽期间避免每帧触发字体测量。 */
const FIT_THROTTLE_MS = 80;

function waitForTerminalSyncRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export interface TerminalGrid {
  columns: number;
  rows: number;
}

export function isSameTerminalGrid(previous: TerminalGrid | undefined, current: TerminalGrid): boolean {
  return previous?.columns === current.columns && previous.rows === current.rows;
}
