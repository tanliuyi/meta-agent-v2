import { Files, ListTodo, PanelRightClose, Plus, TerminalSquare } from "lucide-react";
import { Suspense } from "react";
import { useDesktop } from "../../state/desktop-context.tsx";
import { Button } from "../ui/button.tsx";
import { useResize } from "../ui/use-resize.ts";
import { FilePanel } from "./file-panel.tsx";
import { LazyTerminalView } from "./lazy-terminal-view.tsx";

/** 与当前 session 绑定的可停靠 Workbench Panel。 */
export function WorkbenchPanel() {
  const { snapshot, workbench, updateWorkbench } = useDesktop();
  if (!snapshot || !workbench?.panelOpen) return null;
  return (
    <OpenWorkbenchPanel width={workbench.panelWidth} onWidthChange={(panelWidth) => updateWorkbench({ panelWidth })} />
  );
}

function OpenWorkbenchPanel({ width, onWidthChange }: { width: number; onWidthChange(width: number): void }) {
  const { workbench, updateWorkbench } = useDesktop();
  const resize = useResize({
    value: width,
    min: 360,
    max: Math.min(window.innerWidth * 0.68, 760),
    direction: -1,
    onCommit: onWidthChange,
  });
  if (!workbench) return null;
  return (
    <aside className="workbench-panel" style={{ width: resize.size }}>
      <div
        className="resize-handle resize-handle-panel"
        role="separator"
        tabIndex={0}
        aria-label="调整右侧 Panel 宽度"
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={Math.round(Math.min(window.innerWidth * 0.68, 760))}
        aria-valuenow={resize.size}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
      />
      <header className="panel-tabs">
        <PanelTab active={workbench.panel === "terminal"} onClick={() => updateWorkbench({ panel: "terminal" })}>
          <TerminalSquare size={14} /> 终端
        </PanelTab>
        <PanelTab active={workbench.panel === "files"} onClick={() => updateWorkbench({ panel: "files" })}>
          <Files size={14} /> 打开文件
        </PanelTab>
        <PanelTab active={workbench.panel === "tasks"} onClick={() => updateWorkbench({ panel: "tasks" })}>
          <ListTodo size={14} /> 侧边任务
        </PanelTab>
        <Button variant="ghost" size="icon" aria-label="新建 Panel" className="panel-add">
          <Plus size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭 Panel"
          onClick={() => updateWorkbench({ panelOpen: false })}
        >
          <PanelRightClose size={14} />
        </Button>
      </header>
      <div className="panel-content">
        {workbench.panel === "files" ? <FilePanel /> : null}
        {workbench.panel === "terminal" ? <TerminalPanel /> : null}
        {workbench.panel === "tasks" ? <TaskPanel /> : null}
      </div>
    </aside>
  );
}

function PanelTab({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" className={active ? "panel-tab is-active" : "panel-tab"} onClick={onClick}>
      {children}
    </button>
  );
}

function TerminalPanel() {
  const { project } = useDesktop();
  return (
    <div className="terminal-panel">
      <div className="terminal-title">
        <TerminalSquare size={14} />
        <span>{project?.cwd}</span>
      </div>
      <Suspense fallback={<div className="terminal-view" aria-busy="true" />}>
        <LazyTerminalView terminalId="panel" />
      </Suspense>
    </div>
  );
}

function TaskPanel() {
  const { snapshot } = useDesktop();
  if (!snapshot) return null;
  return (
    <div className="task-panel">
      <h3>会话状态</h3>
      <dl>
        <div>
          <dt>运行</dt>
          <dd>{snapshot.running ? "进行中" : "空闲"}</dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd>
            {snapshot.context?.percent === null || snapshot.context?.percent === undefined
              ? "--"
              : `${snapshot.context.percent.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>队列</dt>
          <dd>{snapshot.queue.steering.length + snapshot.queue.followUp.length}</dd>
        </div>
        <div>
          <dt>压缩</dt>
          <dd>{snapshot.compacting ? "进行中" : "空闲"}</dd>
        </div>
      </dl>
      {Object.keys(snapshot.extensionUi.statuses).length > 0 ? (
        <>
          <h3>扩展状态</h3>
          <ul>
            {Object.entries(snapshot.extensionUi.statuses).map(([key, value]) => (
              <li key={key}>
                <span>{key}</span>
                <strong>{value}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
