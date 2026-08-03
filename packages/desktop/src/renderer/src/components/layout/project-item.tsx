import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button } from "@renderer/shared/ui/button";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { ContextMenuContent } from "@renderer/shared/ui/context-menu-content";
import { ContextMenuItem } from "@renderer/shared/ui/context-menu-item";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { type FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../../../shared/contracts.ts";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjectThreads } from "../../state/desktop-selectors.ts";
import { readStoredProjectExpanded, writeStoredProjectExpanded } from "../../state/project-expansion-preference.ts";
import { useThreadPinning } from "../../state/thread-pinning-context.tsx";
import { pinnedThreadKey } from "../../state/thread-pinning-preference.ts";
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
  const { pinnedThreadKeys } = useThreadPinning();
  const visibleThreads = useMemo(
    () => threads?.filter((thread) => !pinnedThreadKeys.has(pinnedThreadKey(thread.projectId, thread.id))),
    [pinnedThreadKeys, threads],
  );
  const [expanded, setExpanded] = useState(() => readStoredProjectExpanded(project.id, active));
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [renameName, setRenameName] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const wasActive = useRef(active);
  const threadListId = `project-threads-${project.id}`;
  const showRunningIndicator =
    !expanded && visibleThreads?.some(({ archived, running }) => !archived && running) === true;
  const showCompletedIndicator =
    !expanded &&
    visibleThreads?.some(({ archived, completed, running }) => !archived && !running && completed === true) === true;

  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    if (!becameActive) return;
    setExpanded(true);
    writeStoredProjectExpanded(project.id, true);
  }, [active, project.id]);

  useEffect(() => {
    if (!expanded || threads !== undefined) return;
    let current = true;
    setLoading(true);
    void actions
      .loadProjectThreads(project.id)
      .catch(() => undefined)
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [actions, expanded, project.id, threads]);

  const handleOpenChange = (next: boolean) => {
    setExpanded(next);
    writeStoredProjectExpanded(project.id, next);
  };

  const runProjectAction = (action: () => Promise<void>): Promise<void> => {
    if (pendingAction) return Promise.reject(new Error("Project action is already pending"));
    setPendingAction(true);
    return action().finally(() => setPendingAction(false));
  };

  const commitRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = renameName?.trim();
    if (!name || name === project.name) {
      setRenameName(null);
      return;
    }
    setRenameName(null);
    void runProjectAction(() => actions.renameProject(project.id, name)).catch(() => undefined);
  };

  const confirmDelete = () => runProjectAction(() => actions.removeProject(project.id));

  return (
    <li className="project-group" data-project-id={project.id}>
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div
              className="project-row group hover:bg-foreground/[0.055] active:bg-foreground/[0.09] data-[state=open]:bg-foreground/[0.055] grid h-8 grid-cols-[minmax(0,1fr)_auto] items-center rounded-xl pe-1.5 transition-colors"
              data-active={active || undefined}
              data-pending={pendingAction || undefined}
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="focus-visible:ring-ring/50 flex h-8 min-w-0 items-center gap-2 rounded-xl px-2.5 text-left text-sm outline-none focus-visible:ring-[3px]"
                >
                  {expanded ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 select-none truncate font-medium">{project.name}</span>
                  {project.available ? null : <span className="project-warning">不可用</span>}
                </button>
              </CollapsibleTrigger>
              <div
                className={
                  showRunningIndicator
                    ? "flex h-6 w-6 shrink-0 overflow-hidden transition-[width] group-hover:w-12 group-has-focus-visible:w-12"
                    : "size-6 shrink-0"
                }
              >
                {showRunningIndicator ? (
                  <span
                    className="text-muted-foreground/60 grid size-6 shrink-0 place-items-center"
                    aria-label={`${project.name} 中有任务正在运行`}
                  >
                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  </span>
                ) : showCompletedIndicator ? (
                  <span
                    className="text-muted-foreground/60 grid size-6 shrink-0 place-items-center"
                    aria-label={`${project.name} 中有任务已完成`}
                  >
                    <span className="completed-dot" aria-hidden="true" />
                  </span>
                ) : null}
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
            </div>
          </ContextMenu.Trigger>
          <ContextMenuContent className="min-w-44">
            <ContextMenuItem disabled={pendingAction} onSelect={() => setRenameName(project.name)}>
              <Pencil /> 重命名
            </ContextMenuItem>
            <ContextMenuItem
              disabled={pendingAction}
              onSelect={() =>
                void runProjectAction(() => actions.openProjectExternally(project.id)).catch(() => undefined)
              }
            >
              <FolderOpen /> {window.desktop.platform === "darwin" ? "在 Finder 中打开" : "在资源管理器中打开"}
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" disabled={pendingAction} onSelect={() => setDeletePending(true)}>
              <Trash2 /> 删除
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu.Root>
        <CollapsibleContent id={threadListId} animation="height">
          {threads ? (
            visibleThreads && visibleThreads.length > 0 ? (
              <DesktopThreadList project={project} threads={threads} displayThreads={visibleThreads} />
            ) : (
              <div className="flex h-8 items-center gap-2 px-8 text-sm text-muted-foreground" role="status">
                <span>没有会话</span>
              </div>
            )
          ) : loading ? (
            <div className="flex h-8 items-center gap-2 px-8 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              <span>加载中</span>
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
      <Dialog
        open={renameName !== null}
        onOpenChange={(open) => {
          if (!open) setRenameName(null);
        }}
      >
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogTitle>重命名项目</DialogTitle>
          <DialogDescription>仅修改项目列表中的名称，不会重命名实际项目目录。</DialogDescription>
          <form className="mt-2 space-y-4" onSubmit={commitRename}>
            <Input
              autoFocus
              aria-label="项目名称"
              value={renameName ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenameName(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">取消</Button>
              </DialogClose>
              <Button type="submit" disabled={!renameName?.trim()}>
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deletePending}
        title="删除项目"
        description={`仅从项目列表移除“${project.name}”。对应的会话、项目目录及其中的文件都会保留。`}
        onOpenChange={setDeletePending}
        onConfirm={confirmDelete}
      />
    </li>
  );
});
