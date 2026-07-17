import { Folder, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "../../../../shared/contracts.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { DesktopThreadList } from "./desktop-thread-list.tsx";

interface ProjectListProps {
  projects: Project[];
  projectId?: string;
  newTaskDisabled: boolean;
  onProjectExpand(projectId: string): void;
  onNewTask(projectId: string): void;
}

/** 渲染 Project 与其活动、归档 session 列表。 */
export function ProjectList(props: ProjectListProps) {
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(props.projectId ? [props.projectId] : []),
  );

  useEffect(() => {
    const projectId = props.projectId;
    if (!projectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      return new Set(current).add(projectId);
    });
  }, [props.projectId]);

  return (
    <ul className="m-0 list-none p-0">
      {props.projects.map((project) => {
        const active = props.projectId === project.id;
        const expanded = expandedProjectIds.has(project.id);

        return (
          <ProjectItem
            key={project.id}
            project={project}
            active={active}
            expanded={expanded}
            newTaskDisabled={props.newTaskDisabled}
            onNewTask={props.onNewTask}
            onExpandedChange={(nextExpanded) => {
              setExpandedProjectIds((current) => {
                const next = new Set(current);
                if (nextExpanded) next.add(project.id);
                else next.delete(project.id);
                return next;
              });
              if (nextExpanded) props.onProjectExpand(project.id);
            }}
          />
        );
      })}
    </ul>
  );
}

interface ProjectItemProps {
  project: Project;
  active: boolean;
  expanded: boolean;
  newTaskDisabled: boolean;
  onExpandedChange(expanded: boolean): void;
  onNewTask(projectId: string): void;
}

function ProjectItem(props: ProjectItemProps) {
  return (
    <li className="project-group" data-project-id={props.project.id}>
      <div
        role="button"
        tabIndex={0}
        className="project-row group hover:bg-muted focus-visible:bg-muted focus-visible:ring-ring/50 grid h-8 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center rounded-md pe-1.5 outline-none transition-colors focus-visible:ring-[3px]"
        data-active={props.active || undefined}
        aria-current={props.active ? "page" : undefined}
        aria-expanded={props.expanded}
        aria-controls={`project-threads-${props.project.id}`}
        onClick={() => props.onExpandedChange(!props.expanded)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          props.onExpandedChange(!props.expanded);
        }}
      >
        <div className="flex min-w-0 items-center gap-2 px-2.5 text-sm">
          <Folder className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{props.project.name}</span>
          {props.project.available ? null : <span className="project-warning">不可用</span>}
        </div>
        <TooltipIconButton
          tooltip="新建任务"
          side="right"
          disabled={!props.project.available || props.newTaskDisabled}
          className="text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-focus-visible:opacity-100"
          aria-label={`在 ${props.project.name} 中新建任务`}
          onClick={(event) => {
            event.stopPropagation();
            props.onNewTask(props.project.id);
          }}
        >
          <Plus className="size-3.5" />
        </TooltipIconButton>
      </div>
      {props.expanded ? <DesktopThreadList id={`project-threads-${props.project.id}`} project={props.project} /> : null}
    </li>
  );
}
