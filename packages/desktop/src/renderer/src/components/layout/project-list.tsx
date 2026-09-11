import { type DragEvent, memo, useCallback, useMemo, useRef, useState } from "react";
import { isUserProject, type Project } from "../../../../shared/contracts.ts";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjects } from "../../state/desktop-selectors.ts";
import { type ProjectDropPosition, ProjectItem } from "./project-item.tsx";

interface ProjectListProps {
  activeProjectId: string | null;
  newTaskDisabled: boolean;
  onNewTask(projectId: string): void;
}

interface ProjectDropTarget {
  projectId: string;
  position: ProjectDropPosition;
}

/** 渲染 Project 与其活动 session 列表。 */
export const ProjectList = memo(function ProjectList({
  activeProjectId,
  newTaskDisabled,
  onNewTask,
}: ProjectListProps) {
  const actions = useDesktopActions();
  const projects = useDesktopSelector(selectProjects);
  const userProjects = useMemo(() => projects.filter(isUserProject), [projects]);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProjectDropTarget | null>(null);
  const [reordering, setReordering] = useState(false);
  const reorderPending = useRef(false);

  const handleDragStart = useCallback((event: DragEvent<HTMLElement>, projectId: string) => {
    if (reorderPending.current) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
    setDraggedProjectId(projectId);
  }, []);

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>, projectId: string) => {
      if (!draggedProjectId || reorderPending.current) return;
      if (draggedProjectId === projectId) {
        setDropTarget(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      setDropTarget((current) =>
        current?.projectId === projectId && current.position === position ? current : { projectId, position },
      );
    },
    [draggedProjectId],
  );

  const resetDrag = useCallback(() => {
    setDraggedProjectId(null);
    setDropTarget(null);
  }, []);

  const commitProjectOrder = useCallback(
    async (projectIds: string[] | null): Promise<void> => {
      if (!projectIds || reorderPending.current) return;
      reorderPending.current = true;
      setReordering(true);
      try {
        await actions.reorderProjects(projectIds);
      } catch {
        // The desktop action publishes the failure through shared state.
      } finally {
        reorderPending.current = false;
        setReordering(false);
      }
    },
    [actions],
  );

  const moveHandlers = useMemo(
    () =>
      new Map(
        userProjects.map((project, index) => [
          project.id,
          {
            up: index > 0 ? () => void commitProjectOrder(moveProjectId(userProjects, project.id, -1)) : undefined,
            down:
              index < userProjects.length - 1
                ? () => void commitProjectOrder(moveProjectId(userProjects, project.id, 1))
                : undefined,
          },
        ]),
      ),
    [commitProjectOrder, userProjects],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>, projectId: string) => {
      event.preventDefault();
      if (reorderPending.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      const projectIds = reorderProjectIds(userProjects, draggedProjectId, projectId, position);
      resetDrag();
      void commitProjectOrder(projectIds);
    },
    [commitProjectOrder, draggedProjectId, resetDrag, userProjects],
  );

  if (userProjects.length === 0) {
    return <p className="px-2 py-3 text-sm text-muted-foreground">没有项目</p>;
  }

  return (
    <ul className="m-0 list-none p-0">
      {userProjects.map((project) => {
        const handlers = moveHandlers.get(project.id);
        return (
          <ProjectItem
            key={project.id}
            project={project}
            active={activeProjectId === project.id}
            newTaskDisabled={newTaskDisabled}
            dragging={draggedProjectId === project.id}
            dropPosition={dropTarget?.projectId === project.id ? dropTarget.position : null}
            reordering={reordering}
            onNewTask={onNewTask}
            onMoveUp={handlers?.up}
            onMoveDown={handlers?.down}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={resetDrag}
          />
        );
      })}
    </ul>
  );
});

export function moveProjectId(projects: Project[], projectId: string, offset: -1 | 1): string[] | null {
  const index = projects.findIndex(({ id }) => id === projectId);
  const target = projects[index + offset];
  if (index === -1 || !target) return null;
  return reorderProjectIds(projects, projectId, target.id, offset === -1 ? "before" : "after");
}

export function reorderProjectIds(
  projects: Project[],
  draggedProjectId: string | null,
  targetProjectId: string,
  position: ProjectDropPosition,
): string[] | null {
  if (!draggedProjectId || draggedProjectId === targetProjectId) return null;
  const currentIds = projects.map(({ id }) => id);
  if (!currentIds.includes(draggedProjectId) || !currentIds.includes(targetProjectId)) return null;
  const reordered = currentIds.filter((projectId) => projectId !== draggedProjectId);
  const targetIndex = reordered.indexOf(targetProjectId);
  reordered.splice(targetIndex + (position === "after" ? 1 : 0), 0, draggedProjectId);
  return reordered.every((projectId, index) => projectId === currentIds[index]) ? null : reordered;
}
