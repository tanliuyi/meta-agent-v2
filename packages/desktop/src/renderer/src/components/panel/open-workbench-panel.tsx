import * as Tabs from "@radix-ui/react-tabs";
import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { Button } from "@renderer/shared/ui/button";
import Files from "lucide-react/dist/esm/icons/files.mjs";
import ListTodo from "lucide-react/dist/esm/icons/list-todo.mjs";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import type { CSSProperties } from "react";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { FilePanel } from "./file-panel.tsx";
import { isWorkbenchPanelValue, type WorkbenchPanelValue } from "./panel-model.ts";
import { PanelTab } from "./panel-tab.tsx";
import { TaskPanel } from "./task-panel.tsx";
import { TerminalPanel } from "./terminal-panel.tsx";

interface OpenWorkbenchPanelProps {
  width: number;
  panel: WorkbenchPanelValue;
}

const getPanelMaxSize = () => Math.min(window.innerWidth * 0.68, 760);

/** 渲染已打开的可调整 Workbench，并由 Radix Tabs 管理 tab/tabpanel 语义。 */
export function OpenWorkbenchPanel({ width, panel }: OpenWorkbenchPanelProps) {
  const actions = useDesktopActions();
  const resize = useResizableRegion<HTMLDivElement>({
    value: width,
    min: 360,
    getMaxSize: getPanelMaxSize,
    direction: -1,
    orientation: "vertical",
    onCommit: (panelWidth) => actions.updateWorkbench({ panelWidth }),
  });

  return (
    <Tabs.Root
      ref={resize.regionRef}
      className="workbench-panel"
      style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
      value={panel}
      orientation="horizontal"
      role="complementary"
      aria-label="工作台 Panel"
      onValueChange={(value) => {
        if (isWorkbenchPanelValue(value)) actions.updateWorkbench({ panel: value });
      }}
    >
      <div
        ref={resize.separatorRef}
        className="resize-handle resize-handle-panel"
        role="separator"
        tabIndex={0}
        aria-label="调整右侧 Panel 宽度"
        aria-controls="workbench-panel-content"
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={resize.initialMax}
        aria-valuenow={resize.initialSize}
        aria-valuetext={`${resize.initialSize} 像素`}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
      />
      <header className="panel-tabs">
        <Tabs.List className="panel-tab-list" aria-label="工作台视图">
          <PanelTab value="terminal" label="终端" icon={<TerminalSquare size={14} />} />
          <PanelTab value="files" label="打开文件" icon={<Files size={14} />} />
          <PanelTab value="tasks" label="侧边任务" icon={<ListTodo size={14} />} />
        </Tabs.List>
        <Button
          variant="ghost"
          size="icon"
          aria-label="新建 Panel（暂不可用）"
          title="新建 Panel（暂不可用）"
          className="panel-add"
          disabled
        >
          <Plus size={14} />
        </Button>
      </header>
      <div id="workbench-panel-content" className="panel-content-stack">
        <Tabs.Content className="panel-content" value="files">
          <FilePanel />
        </Tabs.Content>
        <Tabs.Content className="panel-content" value="terminal">
          <TerminalPanel />
        </Tabs.Content>
        <Tabs.Content className="panel-content" value="tasks">
          <TaskPanel />
        </Tabs.Content>
      </div>
    </Tabs.Root>
  );
}
