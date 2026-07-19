import { ThreadListPrimitive } from "@assistant-ui/react";
import { Button } from "@renderer/shared/ui/button";
import { ScrollArea } from "@renderer/shared/ui/scroll-area";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import { memo, useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectHasAvailableProject, selectHasDraft } from "../../state/desktop-selectors.ts";
import {
  preventPrimitiveThreadAction,
  runControlledThreadAction,
  runPendingThreadAction,
} from "../../state/thread-list-commands.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { ProjectList } from "./project-list.tsx";

/** Codex Desktop 风格的 Project 与 session 主导航。 */
export const Sidebar = memo(function Sidebar() {
  const actions = useDesktopActions();
  const hasDraft = useDesktopSelector(selectHasDraft);
  const canStartDraft = useDesktopSelector(selectHasAvailableProject);
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const draftPending = hasDraft || pendingKeys.has("draft");

  const startDraft = useCallback(
    (projectId?: string) => {
      void runPendingThreadAction(pendingActions.current, "draft", setPendingKeys, async () => {
        await actions.beginDraft(projectId);
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>("[data-draft-composer] textarea")?.focus(),
        );
      });
    },
    [actions],
  );

  return (
    <ThreadListPrimitive.Root asChild>
      <aside className="sidebar">
        {window.desktop.platform === "darwin" ? <div className="macos-titlebar-space" aria-hidden="true" /> : null}
        <nav className="sidebar-actions" aria-label="主要操作">
          <ThreadListPrimitive.New asChild disabled={!canStartDraft || draftPending}>
            <Button
              variant="ghost"
              data-slot="aui_thread-list-new"
              className="hover:bg-muted data-active:bg-muted h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal"
              data-active={hasDraft || undefined}
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
          <TooltipIconButton
            variant="ghost"
            size="icon"
            aria-label="添加项目"
            tooltip="添加项目"
            side="top"
            onClick={() => void actions.chooseProject()}
          >
            <Plus />
          </TooltipIconButton>
        </div>
        <ScrollArea className="sidebar-projects">
          <ProjectList newTaskDisabled={draftPending} onNewTask={startDraft} />
        </ScrollArea>
        <div className="sidebar-footer">
          <Link to="/settings" className="sidebar-settings-link">
            <Settings size={15} />
            <span>设置</span>
          </Link>
        </div>
      </aside>
    </ThreadListPrimitive.Root>
  );
});
