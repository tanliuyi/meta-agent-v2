import { memo } from "react";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectNavigationProjectId, selectProjects } from "../../state/desktop-selectors.ts";
import { ProjectItem } from "./project-item.tsx";

interface ProjectListProps {
  newTaskDisabled: boolean;
  onNewTask(projectId: string): void;
}

/** 渲染 Project 与其活动 session 列表。 */
export const ProjectList = memo(function ProjectList({ newTaskDisabled, onNewTask }: ProjectListProps) {
  const projects = useDesktopSelector(selectProjects);
  const activeProjectId = useDesktopSelector(selectNavigationProjectId);

  return (
    <ul className="m-0 list-none p-0">
      {projects.map((project) => (
        <ProjectItem
          key={project.id}
          project={project}
          active={activeProjectId === project.id}
          newTaskDisabled={newTaskDisabled}
          onNewTask={onNewTask}
        />
      ))}
    </ul>
  );
});
