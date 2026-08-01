import { memo } from "react";
import { isUserProject } from "../../../../shared/contracts.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjects } from "../../state/desktop-selectors.ts";
import { ProjectItem } from "./project-item.tsx";

interface ProjectListProps {
  activeProjectId: string | null;
  newTaskDisabled: boolean;
  onNewTask(projectId: string): void;
}

/** 渲染 Project 与其活动 session 列表。 */
export const ProjectList = memo(function ProjectList({
  activeProjectId,
  newTaskDisabled,
  onNewTask,
}: ProjectListProps) {
  const projects = useDesktopSelector(selectProjects);

  const userProjects = projects.filter(isUserProject);

  if (userProjects.length === 0) {
    return <p className="px-2 py-3 text-sm text-muted-foreground">没有项目</p>;
  }

  return (
    <ul className="m-0 list-none p-0">
      {userProjects.map((project) => (
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
