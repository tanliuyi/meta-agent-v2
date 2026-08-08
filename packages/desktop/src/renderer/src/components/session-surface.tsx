import { useCallback, useEffect, useState } from "react";
import { ChatThread } from "./chat/chat-thread.tsx";
import { Topbar } from "./layout/topbar.tsx";
import { BottomTerminal } from "./panel/terminal/bottom-terminal.tsx";
import { WorkbenchPanel } from "./panel/workbench-panel.tsx";
import { useSessionScope } from "./session-context.tsx";

/** The complete UI for the currently mounted session. */
export function SessionSurface() {
  const { record, active } = useSessionScope();
  // 侧边栏全屏：右侧 Panel 占满整个 workspace，会话与底部终端让位。页面级状态，不持久化。
  // 全屏入口/出口在 panel-tabs（Panel 全屏时仍可见），Esc 亦可退出。
  const [fullscreen, setFullscreen] = useState(false);
  // 退出全屏不播放宽度过渡：data-fullscreen 移除后 panel.css 的 transition 会恢复并触发动画，
  // 需先行内禁用，待宽度稳定（下一帧）后再恢复。进入方向由 CSS 全屏规则的 transition: none 处理。
  const exitFullscreen = useCallback(() => {
    const panel = document.querySelector<HTMLElement>(".workbench-panel");
    panel?.style.setProperty("transition", "none");
    requestAnimationFrame(() => panel?.style.removeProperty("transition"));
    setFullscreen(false);
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") exitFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitFullscreen, fullscreen]);
  return (
    <>
      <div className="session-surface-shell">
        <Topbar />
        <div className="workspace-row session-surface" data-session-key={record.key} data-active={active || undefined}>
          <main className="chat-workspace">
            <ChatThread />
          </main>
        </div>
      </div>
      <BottomTerminal />
      <WorkbenchPanel
        fullscreen={fullscreen}
        onToggleFullscreen={fullscreen ? exitFullscreen : () => setFullscreen(true)}
      />
    </>
  );
}
