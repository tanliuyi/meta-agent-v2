import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useEffect, useReducer, useRef, useState } from "react";
import { useStore } from "zustand";
import { GENERAL_WORKSPACE_ID } from "../../../../shared/contracts.ts";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { selectProjectThreads } from "../../state/desktop-selectors.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { readStoredProjectExpanded, writeStoredProjectExpanded } from "../../state/project-expansion-preference.ts";
import { runControlledThreadAction } from "../../state/thread-list-commands.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { DesktopThreadList } from "./desktop-thread-list.tsx";

const GENERAL_THREAD_LIST_ID = "general-conversation-threads";

interface GeneralConversationSectionProps {
  active: boolean;
  newConversationDisabled: boolean;
  onNewConversation(): void;
}

/** 通用对话的可折叠历史分组。 */
export function GeneralConversationSection({
  active,
  newConversationDisabled,
  onNewConversation,
}: GeneralConversationSectionProps) {
  const actions = useDesktopActions();
  const desktopStore = useDesktopStore();
  const catalogLoading = useStore(desktopStore, (state) => state.loading);
  const projects = useStore(desktopStore, (state) => state.projects);
  const generalProject = projects.find(({ id }) => id === GENERAL_WORKSPACE_ID) ?? null;
  const generalAvailable = generalProject?.available === true;
  const generalThreads = useStore(desktopStore, (state) => selectProjectThreads(state, GENERAL_WORKSPACE_ID));
  const [expanded, setExpanded] = useState(() => readStoredProjectExpanded(GENERAL_WORKSPACE_ID, true));
  const [loadState, dispatchLoad] = useReducer(reduceGeneralConversationLoad, { attempted: false, failed: false });
  const wasActive = useRef(active);

  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    if (!becameActive) return;
    setExpanded(true);
    writeStoredProjectExpanded(GENERAL_WORKSPACE_ID, true);
  }, [active]);

  useEffect(() => {
    if (!expanded || catalogLoading || generalThreads !== undefined || loadState.attempted) return;
    dispatchLoad({ type: "started" });
    if (!generalAvailable) return;
    actions.loadProjectThreads(GENERAL_WORKSPACE_ID).catch(() => {
      dispatchLoad({ type: "failed" });
    });
  }, [actions, catalogLoading, expanded, generalAvailable, generalThreads, loadState.attempted]);

  function handleOpenChange(next: boolean) {
    setExpanded(next);
    writeStoredProjectExpanded(GENERAL_WORKSPACE_ID, next);
  }

  function retryLoad() {
    dispatchLoad({ type: "retry" });
  }

  return (
    <section className="sidebar-conversation-section" data-expanded={expanded}>
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <div className="sidebar-section-heading">
          <CollapsibleTrigger asChild>
            <button type="button" className="sidebar-section-toggle">
              <span>对话</span>
              {expanded ? (
                <ChevronDown className="sidebar-conversation-control" aria-hidden="true" />
              ) : (
                <ChevronRight className="sidebar-conversation-control" aria-hidden="true" />
              )}
            </button>
          </CollapsibleTrigger>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            aria-label="新建对话"
            tooltip="新建对话"
            side="top"
            disabled={!generalAvailable || newConversationDisabled}
            className="sidebar-conversation-control"
            onClick={(event) => runControlledThreadAction(event, onNewConversation)}
          >
            <Plus />
          </TooltipIconButton>
        </div>
        <CollapsibleContent
          id={GENERAL_THREAD_LIST_ID}
          className="data-closed:animate-collapsible-up data-open:animate-collapsible-down data-open:duration-(--animation-duration) data-closed:duration-(--animation-duration) overflow-hidden"
          role="region"
          aria-label="对话会话列表"
        >
          <div className="sidebar-projects sidebar-conversation-list">
            {catalogLoading ? (
              <div className="flex h-8 items-center gap-2 px-4 text-sm text-muted-foreground" role="status">
                <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                <span>加载中</span>
              </div>
            ) : !generalAvailable ? (
              <div className="flex h-8 items-center gap-2 px-4 text-sm text-destructive" role="status">
                <span>不可用</span>
              </div>
            ) : loadState.failed ? (
              <div className="flex h-8 items-center justify-between gap-2 px-2 text-sm text-destructive" role="status">
                <span>加载失败</span>
                <TooltipIconButton
                  variant="ghost"
                  size="icon"
                  aria-label="重试加载对话"
                  tooltip="重试"
                  className="sidebar-conversation-control"
                  onClick={retryLoad}
                >
                  <RefreshCw />
                </TooltipIconButton>
              </div>
            ) : generalThreads === undefined ? (
              <div className="flex h-8 items-center gap-2 px-4 text-sm text-muted-foreground" role="status">
                <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                <span>加载中</span>
              </div>
            ) : generalThreads.length > 0 && generalProject ? (
              <DesktopThreadList project={generalProject} threads={generalThreads} compactRoot />
            ) : (
              <div className="flex h-8 items-center gap-2 px-2 text-sm text-muted-foreground" role="status">
                <span>没有会话</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

interface GeneralConversationLoadState {
  attempted: boolean;
  failed: boolean;
}

export function reduceGeneralConversationLoad(
  state: GeneralConversationLoadState,
  event: { type: "failed" | "retry" | "started" },
): GeneralConversationLoadState {
  if (event.type === "retry") return { attempted: false, failed: false };
  if (event.type === "failed") return { attempted: true, failed: true };
  return state.attempted && !state.failed ? state : { attempted: true, failed: false };
}
