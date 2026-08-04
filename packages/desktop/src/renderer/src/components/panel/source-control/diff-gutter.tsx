import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import type { GitHunkAction, GitResourceGroup } from "../../../../../shared/git-contracts.ts";
import type { ScmDiffLine } from "./scm-diff-model.ts";

export function DiffGutter({
  line,
  group,
  pending,
  onAction,
}: {
  line: ScmDiffLine;
  group: GitResourceGroup["kind"];
  pending: boolean;
  onAction(action: GitHunkAction, hunkId: string): void;
}) {
  const hunkId = line.hunkId;
  const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : "";
  return (
    <span className="scm-diff-gutter">
      <span className="scm-diff-line-number" aria-hidden="true">
        {line.oldLineNumber}
      </span>
      <span className="scm-diff-line-number" aria-hidden="true">
        {line.newLineNumber}
      </span>
      <span className="scm-diff-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="scm-diff-hunk-actions">
        {hunkId && group === "staged" ? (
          <TooltipIconButton
            className="scm-diff-hunk-action"
            tooltip="撤销暂存块"
            aria-label="撤销暂存块"
            disabled={pending}
            onClick={() => onAction("unstage", hunkId)}
          >
            <Minus />
          </TooltipIconButton>
        ) : null}
        {hunkId && (group === "unstaged" || group === "untracked") ? (
          <TooltipIconButton
            className="scm-diff-hunk-action"
            tooltip="暂存块"
            aria-label="暂存块"
            disabled={pending}
            onClick={() => onAction("stage", hunkId)}
          >
            <Plus />
          </TooltipIconButton>
        ) : null}
        {hunkId && group === "unstaged" ? (
          <TooltipIconButton
            className="scm-diff-hunk-action"
            tooltip="还原块"
            aria-label="还原块"
            disabled={pending}
            onClick={() => onAction("discard", hunkId)}
          >
            <RotateCcw />
          </TooltipIconButton>
        ) : null}
      </span>
    </span>
  );
}
