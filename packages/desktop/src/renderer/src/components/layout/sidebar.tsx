import { ThreadListPrimitive } from "@assistant-ui/react";
import { CircleHelp, FolderPlus, Plus, Search, Settings } from "lucide-react";
import { memo, useRef, useState } from "react";
import { useDesktopNavigation } from "../../state/desktop-context.tsx";
import {
  preventPrimitiveThreadAction,
  runControlledThreadAction,
  runPendingThreadAction,
} from "../../state/thread-list-commands.ts";
import { Button } from "../ui/button.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { ProjectList } from "./project-list.tsx";

/** Codex Desktop 风格的 Project 与 session 主导航。 */
export const Sidebar = memo(function Sidebar() {
  const desktop = useDesktopNavigation();
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const draftPending = desktop.draft !== null || pendingKeys.has("draft");
  const canStartDraft = desktop.projects.some(({ available }) => available);

  const startDraft = (projectId?: string) => {
    void runPendingThreadAction(pendingActions.current, "draft", setPendingKeys, async () => {
      await desktop.beginDraft(projectId);
      requestAnimationFrame(() =>
        document.querySelector<HTMLTextAreaElement>("[data-draft-composer] textarea")?.focus(),
      );
    });
  };

  return (
    <ThreadListPrimitive.Root asChild>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <strong>Meta Agent</strong>
          <Button variant="ghost" size="icon" aria-label="搜索">
            <Search size={16} />
          </Button>
        </div>
        <nav className="sidebar-actions" aria-label="主要操作">
          <ThreadListPrimitive.New asChild disabled={!canStartDraft || draftPending}>
            <Button
              variant="ghost"
              data-slot="aui_thread-list-new"
              className="hover:bg-muted data-active:bg-muted h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal"
              data-active={desktop.draft !== null || undefined}
              onClickCapture={preventPrimitiveThreadAction}
              onClick={(event) =>
                runControlledThreadAction(event, () => {
                  startDraft();
                })
              }
            >
              <Plus size={16} />
              <span className="whitespace-nowrap">新建任务</span>
            </Button>
          </ThreadListPrimitive.New>
        </nav>

        <div className="sidebar-section-heading">
          <span>项目</span>
          <Button variant="ghost" size="icon" aria-label="添加项目" onClick={() => void desktop.chooseProject()}>
            <FolderPlus size={12} />
          </Button>
        </div>
        <ScrollArea className="sidebar-projects">
          <ProjectList
            projects={desktop.projects}
            projectId={desktop.project?.id}
            newTaskDisabled={draftPending}
            onProjectExpand={(id) => void desktop.loadProjectThreads(id)}
            onNewTask={startDraft}
          />
        </ScrollArea>
        <div className="sidebar-footer">
          <button type="button">
            <Settings size={15} />
            设置
          </button>
          <Button variant="ghost" size="icon" aria-label="帮助">
            <CircleHelp size={15} />
          </Button>
        </div>
      </aside>
    </ThreadListPrimitive.Root>
  );
});
