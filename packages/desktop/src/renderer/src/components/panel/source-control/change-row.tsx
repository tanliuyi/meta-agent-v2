import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import type { CSSProperties } from "react";
import type { GitChange, GitChangeKind, GitResourceGroup } from "../../../../../shared/git-contracts.ts";

const KIND_LETTERS: Record<GitChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  unmerged: "U",
  untracked: "?",
};

/** 取行内展示的状态字母（对齐 VS Code scmViewPane 的 resource 图标语义）。 */
function changeKind(change: GitChange, group: GitResourceGroup["kind"]): GitChangeKind {
  if (group === "untracked") return "untracked";
  if (group === "merge") return "unmerged";
  return group === "staged" ? (change.indexKind ?? "modified") : (change.worktreeKind ?? "modified");
}

/**
 * 单个变更行：状态字母 + 文件名 + 悬停操作（暂存/撤销暂存/放弃）。
 * 单击选中并查看 diff（对齐 VS Code SCM 视图的单击打开 diff）。
 */
export function ChangeRow({
  change,
  group,
  depth,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onOpen,
}: {
  change: GitChange;
  group: GitResourceGroup["kind"];
  depth: number;
  selected: boolean;
  onSelect(): void;
  onStage(): void;
  onUnstage(): void;
  onDiscard(): void;
  onOpen(): void;
}) {
  const kind = changeKind(change, group);
  const label = change.originalPath ? `${change.originalPath} → ${change.path}` : change.path;
  return (
    <div
      className="scm-change-row"
      title={label}
      data-selected={selected || undefined}
      style={{ "--scm-indent": `${depth * 10}px` } as CSSProperties}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <span className="scm-change-kind" data-kind={kind} aria-hidden="true">
        {KIND_LETTERS[kind]}
      </span>
      <span className="scm-change-path">{change.path.split("/").at(-1)}</span>
      {change.originalPath ? <span className="scm-change-original">{change.originalPath}</span> : null}
      <span className="scm-change-actions" onClick={(event) => event.stopPropagation()}>
        {group === "staged" ? (
          <TooltipIconButton variant="ghost" size="icon" aria-label="撤销暂存" tooltip="撤销暂存" onClick={onUnstage}>
            <Minus />
          </TooltipIconButton>
        ) : group === "unstaged" || group === "untracked" ? (
          <TooltipIconButton variant="ghost" size="icon" aria-label="暂存更改" tooltip="暂存更改" onClick={onStage}>
            <Plus />
          </TooltipIconButton>
        ) : null}
        {group === "unstaged" ? (
          <TooltipIconButton variant="ghost" size="icon" aria-label="放弃更改" tooltip="放弃更改" onClick={onDiscard}>
            <RotateCcw />
          </TooltipIconButton>
        ) : null}
      </span>
    </div>
  );
}
