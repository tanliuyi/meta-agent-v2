import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { Button } from "@renderer/shared/ui/button";
import { Link, useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import { type CSSProperties, memo, useCallback } from "react";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectHasAvailableProject } from "../../state/desktop-selectors.ts";
import { useLayout } from "../../state/layout.tsx";
import { getSidebarMaxWidth, SIDEBAR_MIN_WIDTH } from "../../state/layout-preference.ts";
import { useSessionCacheSnapshot } from "../../state/session-cache-context.tsx";
import { draftSearch } from "../../state/session-navigation.ts";
import { settingsReturnSession, validateSettingsSearch } from "../../state/settings-navigation.ts";
import { runControlledThreadAction } from "../../state/thread-list-commands.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { ProjectList } from "./project-list.tsx";
import { UpdateBanner } from "./update-banner.tsx";

/** 侧边栏行统一样式:新建任务、插件中心、设置共用,保证字号与高亮一致。 */
const sidebarRowClass =
  "hover:bg-muted data-active:bg-muted aria-[current=page]:bg-muted h-8 w-full justify-start gap-2 rounded-md px-2.5 text-sm font-normal";

/** Codex Desktop 风格的 Project 与 session 主导航。 */
export const Sidebar = memo(function Sidebar() {
  const actions = useDesktopActions();
  const canStartDraft = useDesktopSelector(selectHasAvailableProject);
  const { draftMaterializing } = useSessionCacheSnapshot();
  const { sidebarWidth, setSidebarWidth } = useLayout();
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false });
  const returnSession = settingsReturnSession(validateSettingsSearch(routeSearch));
  const sessionRoute = matchRoute({
    to: "/projects/$projectId/session/$threadId",
    fuzzy: false,
  });
  const activeProjectId = sessionRoute ? sessionRoute.projectId : (returnSession?.projectId ?? null);
  const settingsSearch = sessionRoute
    ? {
        returnProjectId: sessionRoute.projectId,
        returnThreadId: sessionRoute.threadId,
      }
    : returnSession
      ? {
          returnProjectId: returnSession.projectId,
          returnThreadId: returnSession.threadId,
        }
      : {};
  const resize = useResizableRegion<HTMLElement>({
    value: sidebarWidth,
    min: SIDEBAR_MIN_WIDTH,
    getMaxSize: getSidebarMaxWidth,
    direction: 1,
    orientation: "vertical",
    commitViewportClamp: false,
    onCommit: setSidebarWidth,
  });

  const startDraft = useCallback(
    (projectId?: string) => {
      void navigate({
        to: "/new",
        search: draftSearch(projectId),
      });
    },
    [navigate],
  );

  return (
    <aside
      ref={resize.regionRef}
      className="sidebar"
      style={
        {
          "--resizable-region-size": `${resize.initialSize}px`,
        } as CSSProperties
      }
    >
      <div
        ref={resize.separatorRef}
        className="resize-handle resize-handle-sidebar"
        role="separator"
        tabIndex={0}
        aria-label="调整侧边栏宽度"
        aria-controls="sidebar-content"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={resize.initialMax}
        aria-valuenow={resize.initialSize}
        aria-valuetext={`${resize.initialSize} 像素`}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
      />
      <div id="sidebar-content" className="sidebar-content">
        {window.desktop.platform === "darwin" ? <div className="macos-titlebar-space" aria-hidden="true" /> : null}
        <nav className="sidebar-actions" aria-label="主要操作">
          <Button
            variant="ghost"
            disabled={!canStartDraft || draftMaterializing}
            className={sidebarRowClass}
            onClick={(event) =>
              runControlledThreadAction(event, () => {
                startDraft();
              })
            }
          >
            <Plus size={16} />
            <span className="whitespace-nowrap">新建任务</span>
          </Button>
          <Button asChild variant="ghost" className={sidebarRowClass}>
            <Link to="/plugins" search={settingsSearch}>
              <Blocks size={16} />
              <span className="whitespace-nowrap">插件中心</span>
            </Link>
          </Button>
        </nav>

        <div className="sidebar-section-heading">
          <span>项目</span>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            aria-label="添加项目"
            tooltip="添加项目"
            side="top"
            onClick={() => void actions.chooseProject().catch(() => undefined)}
          >
            <Plus />
          </TooltipIconButton>
        </div>
        <div className="sidebar-projects">
          <ProjectList activeProjectId={activeProjectId} newTaskDisabled={draftMaterializing} onNewTask={startDraft} />
        </div>

        <div className="sidebar-footer">
          <UpdateBanner />
          <Button asChild variant="ghost" className={sidebarRowClass}>
            <Link to="/settings/personalization" search={settingsSearch}>
              <Settings size={16} />
              <span className="whitespace-nowrap">设置</span>
            </Link>
          </Button>
        </div>
      </div>
    </aside>
  );
});
