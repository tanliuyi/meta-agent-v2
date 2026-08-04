import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

/** OSC 633 payload 的解析结果；null 表示无法识别的数据。 */
export type Osc633Data = { kind: "prompt" } | { kind: "command" } | { kind: "exit"; exitCode: number } | null;

/** 待结束命令的最大跟踪数：超出时丢弃最旧 marker，防止异常注入下 marker 无限累积。 */
export const MAX_PENDING_COMMANDS = 200;

/** 已创建装饰的最大保留数：超出时丢弃最旧装饰以控制内存。 */
export const MAX_TRACKED_DECORATIONS = 200;

/** 装饰元素类名与退出状态标记（供 CSS 选择器定位命令装饰）。 */
const DECORATION_CLASS = "terminal-command-decoration";
const DECORATION_EXIT_SUCCESS = "success";
const DECORATION_EXIT_ERROR = "error";

/**
 * 解析 xterm OSC handler 收到的 633 payload（即 `]633;` 之后、ST 之前的内容）。
 * - "1"：prompt 开始
 * - "2"：命令开始
 * - "A;<exit-code>"：上一条命令结束（退出码）
 * 其他数据（乱数据、空串、非整数退出码）返回 null。
 */
export function parseOsc633Data(data: string): Osc633Data {
  if (data === "1") return { kind: "prompt" };
  if (data === "2") return { kind: "command" };
  if (data.startsWith("A;")) {
    const exitCodeText = data.slice(2);
    const exitCode = Number(exitCodeText);
    if (exitCodeText === "" || !Number.isInteger(exitCode)) return null;
    return { kind: "exit", exitCode };
  }
  return null;
}

/** 命令装饰管理器的生命周期句柄。 */
export interface CommandDecorationManager {
  dispose(): void;
}

/** 一条已开始但尚未收到 exit 的命令。 */
interface PendingCommand {
  marker: IMarker;
}

/**
 * 注册 OSC 633 处理器，把低配 Shell Integration 序列渲染为命令装饰
 * （参考 VS Code xterm 的 markNavigation / DecorationAddon 思路）：
 * - "2" 命令开始：registerMarker(0) 记录当前行
 * - "A;<code>" 命令结束：在 marker 行注册左缘 2 格宽的装饰，标记成功/失败
 * - "1" prompt 开始：边界防御，丢弃残留的未结束命令（正常时序下 exit 先于 prompt 到达）
 *
 * registerDecoration / registerMarker 属于 xterm 6.0 proposed API，
 * 需要集成方在 Terminal 选项里开启 allowProposedApi: true。
 */
export function createCommandDecorationManager(terminal: Terminal): CommandDecorationManager {
  const pendingCommands: PendingCommand[] = [];
  const trackedDecorations: IDecoration[] = [];
  const oscHandler = terminal.parser.registerOscHandler(633, (data) => {
    const parsed = parseOsc633Data(data);
    switch (parsed?.kind) {
      case "prompt":
        // 边界防御：残留 pending 说明上一条命令的 exit 序列丢失（如 shell 注入不完整），
        // 直接丢弃，避免 marker 与装饰无限累积。
        pendingCommands.length = 0;
        break;
      case "command": {
        pendingCommands.push({ marker: terminal.registerMarker(0) });
        if (pendingCommands.length > MAX_PENDING_COMMANDS) pendingCommands.shift();
        break;
      }
      case "exit": {
        // 无 pending（如 shell 未注入 633;2）直接忽略。
        const command = pendingCommands.pop();
        if (!command) break;
        // marker 可能已随 buffer 滚动被 dispose。
        if (command.marker.isDisposed) break;
        const decoration = terminal.registerDecoration({
          marker: command.marker,
          x: 0,
          width: 2,
          anchor: "left",
          layer: "top",
        });
        // alt buffer 激活或 marker 刚被 dispose 时可能返回 undefined。
        if (!decoration) break;
        applyExitStyle(decoration, parsed.exitCode);
        trackedDecorations.push(decoration);
        if (trackedDecorations.length > MAX_TRACKED_DECORATIONS) {
          const oldest = trackedDecorations.shift();
          if (oldest && !oldest.isDisposed) oldest.dispose();
        }
        break;
      }
      default:
        break;
    }
    // 633 序列全部由本管理器认领，避免 payload 落入其他默认处理器。
    return true;
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      oscHandler.dispose();
      pendingCommands.length = 0;
      for (const decoration of trackedDecorations) {
        if (!decoration.isDisposed) decoration.dispose();
      }
      trackedDecorations.length = 0;
    },
  };
}

/**
 * 给装饰元素打上命令装饰类名与退出状态；xterm 的元素在首次渲染后才存在，
 * 因此元素缺失时监听 onRender（元素创建一次并跨渲染复用，设置一次即可）。
 */
function applyExitStyle(decoration: IDecoration, exitCode: number): void {
  const exit = exitCode === 0 ? DECORATION_EXIT_SUCCESS : DECORATION_EXIT_ERROR;
  let renderSubscription: IDisposable | undefined;
  const apply = (element: HTMLElement) => {
    element.classList.add(DECORATION_CLASS);
    element.dataset.exit = exit;
    renderSubscription?.dispose();
  };
  const element = decoration.element;
  if (element) {
    apply(element);
  } else {
    renderSubscription = decoration.onRender(apply);
  }
}
