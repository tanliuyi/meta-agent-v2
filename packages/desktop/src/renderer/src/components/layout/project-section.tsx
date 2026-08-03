import { Collapsible } from "@renderer/shared/ui/collapsible";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { useEffect, useRef, useState } from "react";
import {
  readStoredProjectExpanded,
  SIDEBAR_PROJECTS_SECTION_ID,
  writeStoredProjectExpanded,
} from "../../state/project-expansion-preference.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { ProjectList } from "./project-list.tsx";

const PROJECT_LIST_ID = "sidebar-project-list";

/** activeProjectId 变化（含非空到非空切换）时自动展开项目分组。 */
export function shouldAutoExpandProjectsSection(
  previousActiveProjectId: string | null,
  activeProjectId: string | null,
): boolean {
  return activeProjectId !== null && activeProjectId !== previousActiveProjectId;
}

interface ProjectSectionProps {
  activeProjectId: string | null;
  newTaskDisabled: boolean;
  onNewTask(projectId: string): void;
  onAddProject(): Promise<void>;
}

/** 项目导航的可折叠分组。 */
export function ProjectSection({ activeProjectId, newTaskDisabled, onNewTask, onAddProject }: ProjectSectionProps) {
  const [expanded, setExpanded] = useState(() => readStoredProjectExpanded(SIDEBAR_PROJECTS_SECTION_ID, true));
  const wasActive = useRef(activeProjectId);

  useEffect(() => {
    const changed = shouldAutoExpandProjectsSection(wasActive.current, activeProjectId);
    wasActive.current = activeProjectId;
    if (!changed) return;
    setExpanded(true);
    writeStoredProjectExpanded(SIDEBAR_PROJECTS_SECTION_ID, true);
  }, [activeProjectId]);

  function handleOpenChange(next: boolean) {
    setExpanded(next);
    writeStoredProjectExpanded(SIDEBAR_PROJECTS_SECTION_ID, next);
  }

  return (
    <section className="sidebar-project-section mt-3" data-expanded={expanded}>
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <div className="sidebar-section-heading">
          <CollapsibleTrigger asChild>
            <button type="button" className="sidebar-section-toggle">
              <span>项目</span>
              {expanded ? (
                <ChevronDown className="sidebar-section-control" aria-hidden="true" />
              ) : (
                <ChevronRight className="sidebar-section-control" aria-hidden="true" />
              )}
            </button>
          </CollapsibleTrigger>
          <TooltipIconButton
            variant="ghost"
            size="icon"
            aria-label="添加项目"
            tooltip="添加项目"
            side="top"
            className="sidebar-section-control"
            onClick={() => void onAddProject().catch(() => undefined)}
          >
            <Plus />
          </TooltipIconButton>
        </div>
        <CollapsibleContent id={PROJECT_LIST_ID} animation="height" role="region" aria-label="项目列表">
          <div className="sidebar-projects">
            <ProjectList activeProjectId={activeProjectId} newTaskDisabled={newTaskDisabled} onNewTask={onNewTask} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
