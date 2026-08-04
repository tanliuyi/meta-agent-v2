import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { errorMessage } from "@renderer/shared/lib/error-message";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import GitCommit from "lucide-react/dist/esm/icons/git-commit.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useMemo, useState } from "react";
import type { GitResourceGroup } from "../../../../../shared/git-contracts.ts";
import { useSourceControlModel } from "../../../state/source-control-model.ts";
import { ExplorerModeSwitch, type ExplorerPanelMode } from "../explorer-mode-switch.tsx";
import { ChangeTree } from "./change-tree.tsx";
import { buildChangeTree, collectTreeChanges, scmTreeExpansionKey } from "./scm-tree.ts";

const GROUP_LABELS: Record<GitResourceGroup["kind"], string> = {
  merge: "合并更改",
  staged: "暂存的更改",
  unstaged: "更改",
  untracked: "未跟踪的更改",
};

/** 资源管理左栏中的 SCM 树；diff 请求与右侧混合 tab 由 FilePanel 统一管理。 */
export function SourceControlTree({
  contentId,
  projectId,
  selectedKey,
  onModeChange,
  onSelect,
  onOpenFile,
}: {
  contentId: string;
  projectId: string;
  selectedKey: string | null;
  onModeChange(value: ExplorerPanelMode): void;
  onSelect(path: string, group: GitResourceGroup["kind"]): void;
  onOpenFile(path: string): void;
}) {
  const model = useSourceControlModel(projectId);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(new Set());
  const state = model.state;
  const canCommit = commitMessage.trim().length > 0 && !committing;
  const groupTrees = useMemo(
    () => new Map(state?.groups.map((group) => [group.kind, buildChangeTree(group.changes)]) ?? []),
    [state],
  );

  const runCommit = async () => {
    const message = commitMessage.trim();
    if (!message) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await model.commit(message);
      if (result.ok) setCommitMessage("");
      else setCommitError(result.message);
    } catch (error) {
      setCommitError(errorMessage(error));
    } finally {
      setCommitting(false);
    }
  };

  const confirmDiscard = (paths: string[]): boolean => {
    const target = paths.length === 0 ? "全部更改" : `${paths.length} 个文件`;
    // eslint-disable-next-line no-alert
    return window.confirm(`放弃对${target}的更改？此操作不可撤销。`);
  };

  const toggleDirectory = (group: GitResourceGroup["kind"], path: string) => {
    const key = scmTreeExpansionKey(group, path);
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openChangedFile = async (path: string) => {
    try {
      await window.desktop.files.resolvePath(projectId, path);
      onOpenFile(path);
    } catch {
      // 删除/重命名目标可能不存在，保持当前 diff。
    }
  };

  return (
    <div id={contentId} className="scm-tree-surface">
      <div className="scm-toolbar">
        <ExplorerModeSwitch value="source-control" onValueChange={onModeChange} />
        {state ? (
          <span className="scm-branch" title={state.root}>
            <GitBranch aria-hidden="true" />
            <span className="scm-branch-name">{state.branch}</span>
            {state.ahead > 0 || state.behind > 0 ? (
              <span className="scm-upstream" aria-label={`领先 ${state.ahead}，落后 ${state.behind}`}>
                {state.ahead > 0 ? <span>↑{state.ahead}</span> : null}
                {state.behind > 0 ? <span>↓{state.behind}</span> : null}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="scm-toolbar-title">源代码管理</span>
        )}
        <TooltipIconButton tooltip="刷新" aria-label="刷新" onClick={() => model.refresh()}>
          <RefreshCw />
        </TooltipIconButton>
      </div>

      <div className="scm-tree-body">
        {model.loadState === "loading" && state === null ? (
          <p className="scm-empty">正在读取仓库状态…</p>
        ) : model.loadState === "error" ? (
          <div className="scm-error">
            <p>{model.errorMessage ?? "无法读取仓库状态"}</p>
            <button type="button" className="scm-error-retry" onClick={() => model.refresh()}>
              重试
            </button>
          </div>
        ) : state ? (
          <>
            <form
              className="scm-commit-box"
              onSubmit={(event) => {
                event.preventDefault();
                void runCommit();
              }}
            >
              <input
                className="scm-commit-input"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="提交信息"
                aria-label="提交信息"
                spellCheck={false}
              />
              <TooltipIconButton
                variant="ghost"
                size="icon"
                type="submit"
                disabled={!canCommit}
                aria-label="提交"
                tooltip="提交"
              >
                <GitCommit />
              </TooltipIconButton>
            </form>
            {commitError ? <p className="scm-commit-error">{commitError}</p> : null}

            {state.groups.map((group) => {
              const tree = groupTrees.get(group.kind) ?? [];
              if (group.changes.length === 0) return null;
              return (
                <section className="scm-group" key={group.kind}>
                  <header className="scm-group-header">
                    <h3 className="scm-group-label">{GROUP_LABELS[group.kind]}</h3>
                    <span className="scm-group-count">{group.changes.length}</span>
                    <span className="scm-group-actions">
                      {group.kind === "staged" ? (
                        <TooltipIconButton
                          variant="ghost"
                          size="icon"
                          aria-label="全部撤销暂存"
                          tooltip="全部撤销暂存"
                          onClick={() =>
                            void model
                              .unstage({ projectId, paths: collectTreeChanges(tree).map((change) => change.path) })
                              .catch(() => undefined)
                          }
                        >
                          <Minus />
                        </TooltipIconButton>
                      ) : group.kind === "merge" ? null : (
                        <TooltipIconButton
                          variant="ghost"
                          size="icon"
                          aria-label="全部暂存"
                          tooltip="全部暂存"
                          onClick={() =>
                            void model
                              .stage({ projectId, paths: collectTreeChanges(tree).map((change) => change.path) })
                              .catch(() => undefined)
                          }
                        >
                          <Plus />
                        </TooltipIconButton>
                      )}
                    </span>
                  </header>
                  <div className="scm-group-tree" role="tree" aria-label={GROUP_LABELS[group.kind]}>
                    <ChangeTree
                      nodes={tree}
                      group={group.kind}
                      depth={0}
                      collapsedDirectories={collapsedDirectories}
                      selectedKey={selectedKey}
                      onToggle={(path) => toggleDirectory(group.kind, path)}
                      onSelect={(path) => onSelect(path, group.kind)}
                      onStage={(path) => void model.stage({ projectId, paths: [path] }).catch(() => undefined)}
                      onUnstage={(path) => void model.unstage({ projectId, paths: [path] }).catch(() => undefined)}
                      onDiscard={(path) => {
                        if (confirmDiscard([path])) {
                          void model.discard({ projectId, paths: [path] }).catch(() => undefined);
                        }
                      }}
                      onOpen={(path) => void openChangedFile(path)}
                    />
                  </div>
                </section>
              );
            })}
            {state.totalChanges === 0 ? <p className="scm-empty">工作区干净，没有更改</p> : null}
          </>
        ) : (
          <p className="scm-empty">暂无活跃项目</p>
        )}
      </div>
    </div>
  );
}
