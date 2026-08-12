import { AssistantModalPrimitive } from "@assistant-ui/react";
import MessagesSquare from "lucide-react/dist/esm/icons/messages-square.mjs";
import { useCallback, useEffect, useState } from "react";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button.tsx";
import { ChatThread } from "./chat/chat-thread.tsx";
import { Topbar } from "./layout/topbar.tsx";
import { BottomTerminal } from "./panel/terminal/bottom-terminal.tsx";
import { WorkbenchPanel } from "./panel/workbench-panel.tsx";
import { useSessionScope } from "./session-context.tsx";

interface SessionSurfaceProps {
  /** 初始全屏态（测试注入用，默认 false）。页面运行期不传。 */
  initialFullscreen?: boolean;
}

/** The complete UI for the currently mounted session. */
export function SessionSurface({ initialFullscreen = false }: SessionSurfaceProps) {
  const { record, active } = useSessionScope();
  // 侧边栏全屏：右侧 Panel 占满整个 workspace，会话与底部终端让位。页面级状态，不持久化。
  // 全屏入口/出口在 panel-tabs（Panel 全屏时仍可见），Esc 亦可退出。
  const [fullscreen, setFullscreen] = useState(initialFullscreen);
  // 全屏期间主会话以浮动 modal（AssistantModalPrimitive）展示；进入全屏不自动打开，
  // 由右下角入口按钮打开。退出全屏时随之下沉关闭。
  const [modalOpen, setModalOpen] = useState(false);
  // 退出全屏不播放宽度过渡：data-fullscreen 移除后 panel.css 的 transition 会恢复并触发动画，
  // 需先行内禁用，待宽度稳定（下一帧）后再恢复。进入方向由 CSS 全屏规则的 transition: none 处理。
  const exitFullscreen = useCallback(() => {
    setModalOpen(false);
    const panel = document.querySelector<HTMLElement>(".workbench-panel");
    panel?.style.setProperty("transition", "none");
    requestAnimationFrame(() => panel?.style.removeProperty("transition"));
    setFullscreen(false);
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Radix Popover 的 DismissableLayer 已在 document 捕获阶段处理 Esc 并关闭 modal，
      // 此处 window 冒泡阶段闭包中的 modalOpen 仍是打开前的值：再关一次无害，且不退出全屏。
      if (modalOpen) {
        setModalOpen(false);
        return;
      }
      exitFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exitFullscreen, fullscreen, modalOpen]);
  // ChatThread 单实例：普通态内联于 chat-workspace，全屏态置于 modal Content（portal 到 body）。
  // 两种形态互斥，同一时刻仅渲染一处；切换会重挂载，会话状态由 SessionProvider/runtime 持有不受影响。
  const thread = <ChatThread />;
  return (
    <>
      {fullscreen ? (
        <AssistantModalPrimitive.Root open={modalOpen} onOpenChange={setModalOpen} unstable_openOnRunStart={false}>
          <AssistantModalPrimitive.Anchor className="session-modal-anchor">
            <AssistantModalPrimitive.Trigger asChild>
              <TooltipIconButton tooltip="查看会话" aria-label="查看会话" side="left" className="session-modal-trigger">
                <MessagesSquare className="size-4" />
              </TooltipIconButton>
            </AssistantModalPrimitive.Trigger>
          </AssistantModalPrimitive.Anchor>
          <AssistantModalPrimitive.Content
            side="top"
            align="end"
            sideOffset={16}
            aria-label="会话对话"
            className="session-modal-content"
          >
            {thread}
          </AssistantModalPrimitive.Content>
        </AssistantModalPrimitive.Root>
      ) : (
        <div className="session-surface-shell">
          <Topbar />
          <div
            className="workspace-row session-surface"
            data-session-key={record.key}
            data-active={active || undefined}
          >
            <main className="chat-workspace">{thread}</main>
          </div>
        </div>
      )}
      <BottomTerminal />
      <WorkbenchPanel
        fullscreen={fullscreen}
        onToggleFullscreen={fullscreen ? exitFullscreen : () => setFullscreen(true)}
      />
    </>
  );
}
