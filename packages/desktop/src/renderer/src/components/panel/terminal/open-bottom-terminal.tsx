import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type CSSProperties, Suspense } from "react";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope, useSessionWorkbenchSelector } from "../../session-context.tsx";
import { TerminalSession } from "./terminal-session.tsx";
import { TerminalTabs, useTerminalTabs } from "./terminal-tabs.tsx";

interface OpenBottomTerminalProps {
  open: boolean;
  height: number;
}

const getTerminalMaxSize = () => window.innerHeight * 0.58;

/** 渲染底部终端；收起时经 data-collapsed 驱动高度过渡动画（同 workbench-panel），
    拖拽瞬态尺寸保留在 DOM。 */
export function OpenBottomTerminal({ open, height }: OpenBottomTerminalProps) {
  const { updateWorkbench } = useSessionScope();
  const persisted = useSessionWorkbenchSelector((workbench) => workbench?.bottomTerminals);
  const resize = useResizableRegion<HTMLElement>({
    value: height,
    min: 160,
    getMaxSize: getTerminalMaxSize,
    direction: -1,
    orientation: "horizontal",
    onCommit: (terminalHeight) => updateWorkbench({ terminalHeight }),
  });
  // tabs 状态持久化到 session workbench state：底部终端收起/重挂载时保留 tab 列表。
  const { tabs, activeId, create, activate, close } = useTerminalTabs("bottom", {
    onLastClosed: () => updateWorkbench({ terminalOpen: false }),
    persist: {
      read: () => persisted,
      write: (state) => updateWorkbench({ bottomTerminals: state }),
    },
  });

  return (
    <section
      ref={resize.regionRef}
      className="bottom-terminal"
      style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
      data-collapsed={!open || undefined}
      aria-hidden={!open}
      aria-label="底部终端"
    >
      {open ? (
        <>
          <div
            ref={resize.separatorRef}
            className="resize-handle resize-handle-terminal"
            role="separator"
            tabIndex={0}
            aria-label="调整底部终端高度"
            aria-controls="bottom-terminal-content"
            aria-orientation="horizontal"
            aria-valuemin={160}
            aria-valuemax={resize.initialMax}
            aria-valuenow={resize.initialSize}
            aria-valuetext={`${resize.initialSize} 像素`}
            onPointerDown={resize.onPointerDown}
            onKeyDown={resize.onKeyDown}
          />
          <header>
            <TerminalTabs tabs={tabs} activeId={activeId} onCreate={create} onActivate={activate} onClose={close} />
            <TooltipIconButton
              tooltip="关闭终端"
              aria-label="关闭终端"
              className="terminal-close"
              onClick={() => updateWorkbench({ terminalOpen: false })}
            >
              <X size={14} />
            </TooltipIconButton>
          </header>
          <div id="bottom-terminal-content" className="terminal-content">
            <Suspense fallback={<div className="terminal-view" aria-busy="true" />}>
              <TerminalSession tabs={tabs} activeId={activeId} />
            </Suspense>
          </div>
        </>
      ) : null}
    </section>
  );
}
