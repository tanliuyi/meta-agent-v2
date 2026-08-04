import { TerminalView } from "./terminal-view.tsx";

/**
 * 多 tab 终端会话：每个 tab 一个 TerminalView 实例并保持挂载，
 * 非激活实例仅 display:none 隐藏（PTY 输出继续写入 buffer），
 * 切换回激活时 ResizeObserver 自动触发 refit。
 */
export function TerminalSession({ tabs, activeId }: { tabs: string[]; activeId: string }) {
  return (
    <div className="terminal-session">
      {tabs.map((terminalId) => (
        <div
          key={terminalId}
          className="terminal-session-item"
          style={terminalId === activeId ? undefined : { display: "none" }}
        >
          <TerminalView terminalId={terminalId} />
        </div>
      ))}
    </div>
  );
}
