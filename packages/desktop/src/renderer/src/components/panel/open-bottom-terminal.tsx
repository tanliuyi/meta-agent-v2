import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { Button } from "@renderer/shared/ui/button";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type CSSProperties, Suspense, useRef } from "react";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { LazyTerminalView } from "./lazy-terminal-view.tsx";
import type { TerminalViewHandle } from "./terminal-view.tsx";

interface OpenBottomTerminalProps {
  height: number;
  name: string;
}

const getTerminalMaxSize = () => window.innerHeight * 0.58;

/** 渲染已打开的底部终端，并将拖拽瞬态尺寸保留在 DOM。 */
export function OpenBottomTerminal({ height, name }: OpenBottomTerminalProps) {
  const actions = useDesktopActions();
  const terminal = useRef<TerminalViewHandle>(null);
  const resize = useResizableRegion<HTMLElement>({
    value: height,
    min: 160,
    getMaxSize: getTerminalMaxSize,
    direction: -1,
    orientation: "horizontal",
    onCommit: (terminalHeight) => actions.updateWorkbench({ terminalHeight }),
  });

  return (
    <section
      ref={resize.regionRef}
      className="bottom-terminal"
      style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
      aria-label="底部终端"
    >
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
        <div className="terminal-tab" data-active="true">
          <TerminalSquare size={13} />
          <span>{name}</span>
        </div>
        <Button variant="ghost" size="icon" aria-label="重新启动终端" onClick={() => void terminal.current?.restart()}>
          <RotateCcw size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭终端"
          className="terminal-close"
          onClick={() => actions.updateWorkbench({ terminalOpen: false })}
        >
          <X size={14} />
        </Button>
      </header>
      <div id="bottom-terminal-content" className="terminal-content">
        <Suspense fallback={<div className="terminal-view" aria-busy="true" />}>
          <LazyTerminalView ref={terminal} terminalId="bottom" />
        </Suspense>
      </div>
    </section>
  );
}
