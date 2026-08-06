import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { Button } from "@renderer/shared/ui/button";
import { Link, useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import { type CSSProperties, memo, useCallback } from "react";
import { GENERAL_WORKSPACE_ID } from "../../../../shared/contracts.ts";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { useDraftSession } from "../../state/draft-session-context.tsx";
import { useLayout } from "../../state/layout.tsx";
import { getSidebarMaxWidth, SIDEBAR_MIN_WIDTH } from "../../state/layout-preference.ts";
import { useSessionDraftMaterializing } from "../../state/session-cache-context.tsx";
import { draftSearch } from "../../state/session-navigation.ts";
import { settingsReturnSession, validateSettingsSearch } from "../../state/settings-navigation.ts";
import { runControlledThreadAction } from "../../state/thread-list-commands.ts";
import { ThreadPinningProvider } from "../../state/thread-pinning-context.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { GeneralConversationSection } from "./general-conversation-section.tsx";
import { PinnedConversationSection } from "./pinned-conversation-section.tsx";
import { ProjectSection } from "./project-section.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { UpdateBanner } from "./update-banner.tsx";

/** 侧边栏行统一样式:新建任务、插件中心、设置共用,保证字号与高亮一致。 */
const sidebarRowClass =
  "hover:bg-foreground/[0.055] active:bg-foreground/[0.09] data-active:bg-foreground/[0.085] aria-[current=page]:bg-foreground/[0.085] h-8 w-full justify-start gap-2 rounded-xl px-2.5 text-sm font-normal";

/** Codex Desktop 风格的 Project 与 session 主导航。floating 模式用于收起后的悬停浮出预览。 */
export const Sidebar = memo(function Sidebar({ floating = false }: { floating?: boolean }) {
  const actions = useDesktopActions();
  const draftMaterializing = useSessionDraftMaterializing();
  const draft = useDraftSession();
  const { sidebarOpen, sidebarWidth, setSidebarWidth } = useLayout();
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
      : {
          // 新会话时缓存当前草稿项目，设置页“返回聊天”恢复到 /new 的选择。
          draftProjectId:
            draft.projectId ?? (typeof routeSearch.projectId === "string" ? routeSearch.projectId : undefined),
        };
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
      data-collapsed={floating ? false : !sidebarOpen}
      data-floating={floating || undefined}
      style={
        {
          "--resizable-region-size": `${resize.initialSize}px`,
        } as CSSProperties
      }
    >
      {floating ? (
        <div className="sidebar-toggle-row">{/* <SidebarToggle location="sidebar" floating /> */}</div>
      ) : window.desktop.platform === "darwin" ? (
        <div className="macos-titlebar-space">
          <SidebarToggle location="sidebar" />
        </div>
      ) : null}
      {floating ? null : (
        <div
          ref={resize.separatorRef}
          className="resize-handle resize-handle-sidebar"
          role="separator"
          tabIndex={sidebarOpen ? 0 : -1}
          aria-hidden={!sidebarOpen}
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
      )}
      <div
        id={floating ? "floating-sidebar-content" : "sidebar-content"}
        className="sidebar-content"
        hidden={floating ? false : !sidebarOpen}
      >
        <ThreadPinningProvider>
          {floating || sidebarOpen ? (
            <>
              {floating ? null : window.desktop.platform === "linux" ? (
                <div className="sidebar-toggle-row">
                  <SidebarToggle location="sidebar" />
                </div>
              ) : null}
              <nav className="sidebar-actions mt-2" aria-label="主要操作">
                <Button
                  variant="ghost"
                  disabled={draftMaterializing}
                  className={sidebarRowClass}
                  onClick={(event) => runControlledThreadAction(event, () => startDraft(activeProjectId ?? undefined))}
                >
                  <Plus size={16} />
                  <span className="whitespace-nowrap">新建任务</span>
                </Button>
              </nav>

              <div className="sidebar-navigation-scroll py-1">
                <nav className="sidebar-actions sidebar-secondary-actions" aria-label="辅助操作">
                  <Button asChild variant="ghost" className={sidebarRowClass}>
                    <Link to="/plugins" search={settingsSearch}>
                      <Blocks size={16} />
                      <span className="whitespace-nowrap">插件中心</span>
                    </Link>
                  </Button>
                </nav>

                <PinnedConversationSection />

                <ProjectSection
                  activeProjectId={activeProjectId}
                  newTaskDisabled={draftMaterializing}
                  onNewTask={startDraft}
                  onAddProject={actions.chooseProject}
                />

                <GeneralConversationSection
                  active={activeProjectId === GENERAL_WORKSPACE_ID}
                  newConversationDisabled={draftMaterializing}
                  onNewConversation={() => startDraft(GENERAL_WORKSPACE_ID)}
                />
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
            </>
          ) : null}
        </ThreadPinningProvider>
      </div>
    </aside>
  );
});
