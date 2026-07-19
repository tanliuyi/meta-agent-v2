import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { memo, useEffect, useState } from "react";
import type { Project } from "../../../../shared/contracts.ts";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjectThreads } from "../../state/desktop-selectors.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { DesktopThreadList } from "./desktop-thread-list.tsx";

interface ProjectItemProps {
  project: Project;
  active: boolean;
  newTaskDisabled: boolean;
  onNewTask(projectId: string): void;
}

/** 渲染单个 Project disclosure，并只订阅该 Project 的 thread catalog。 */
export const ProjectItem = memo(function ProjectItem({
  project,
  active,
  newTaskDisabled,
  onNewTask,
}: ProjectItemProps) {
  const actions = useDesktopActions();
  const threads = useDesktopSelector((state) => selectProjectThreads(state, project.id));
  const [expanded, setExpanded] = useState(active);
  const [loading, setLoading] = useState(false);
  const threadListId = `project-threads-${project.id}`;

  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || threads !== undefined) return;
    setLoading(true);
    void actions.loadProjectThreads(project.id).finally(() => setLoading(false));
  };

  return (
    <li className="project-group" data-project-id={project.id}>
      <div
        className="project-row group hover:bg-muted grid h-8 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md pe-1.5 transition-colors"
        data-active={active || undefined}
      >
        <button
          type="button"
          className="focus-visible:ring-ring/50 flex h-8 min-w-0 items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-[3px]"
          aria-expanded={expanded}
          aria-controls={threadListId}
          onClick={toggleExpanded}
        >
          {expanded ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 select-none truncate">{project.name}</span>
          {project.available ? null : <span className="project-warning">不可用</span>}
        </button>
        <TooltipIconButton
          tooltip="新建任务"
          side="right"
          disabled={!project.available || newTaskDisabled}
          className="text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 disabled:opacity-0"
          aria-label={`在 ${project.name} 中新建任务`}
          onClick={() => onNewTask(project.id)}
        >
          <Plus className="size-3.5" />
        </TooltipIconButton>
      </div>
      <div id={threadListId} hidden={!expanded}>
        {expanded && threads ? (
          <DesktopThreadList project={project} threads={threads} />
        ) : expanded && loading ? (
          <div className="flex h-8 items-center gap-2 px-8 text-xs text-muted-foreground" role="status">
            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            <span>加载中</span>
          </div>
        ) : null}
      </div>
    </li>
  );
});
