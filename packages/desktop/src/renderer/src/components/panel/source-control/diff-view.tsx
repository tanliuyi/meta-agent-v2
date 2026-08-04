import { errorMessage } from "@renderer/shared/lib/error-message";
import { useVirtualizer } from "@tanstack/react-virtual";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type CSSProperties, memo, useCallback, useMemo, useRef, useState } from "react";
import type { GitDiffHunk, GitHunkAction, GitResourceGroup } from "../../../../../shared/git-contracts.ts";
import { DiffGutter } from "./diff-gutter.tsx";
import { parseScmDiff } from "./scm-diff-model.ts";

const SCM_DIFF_LINE_HEIGHT = 20;
const SCM_DIFF_OVERSCAN = 30;

interface DiffViewProps {
  path: string;
  group: GitResourceGroup["kind"];
  patch: string;
  hunks: readonly GitDiffHunk[];
  onClose(): void;
  onHunkAction(action: GitHunkAction, hunkId: string): Promise<void>;
}

/**
 * 完整文件 inline diff。对齐 VS Code ViewLines：完整模型留在内存，DOM 只渲染可见行；
 * 行号、变更符号和块操作位于 sticky gutter，不参与横向滚动。
 */
export const DiffView = memo(function DiffView({ path, group, patch, hunks, onClose, onHunkAction }: DiffViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingHunkId, setPendingHunkId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const model = useMemo(() => parseScmDiff(patch, hunks), [hunks, patch]);
  const virtualizer = useVirtualizer({
    count: model.lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SCM_DIFF_LINE_HEIGHT,
    overscan: SCM_DIFF_OVERSCAN,
    initialRect: { height: 600, width: 600 },
    getItemKey: (index) => model.lines[index]?.key ?? index,
  });

  const runHunkAction = useCallback(
    async (action: GitHunkAction, hunkId: string) => {
      if (action === "discard") {
        // eslint-disable-next-line no-alert
        if (!window.confirm("还原此变更块？此操作不可撤销。")) return;
      }
      setPendingHunkId(hunkId);
      setOperationError(null);
      try {
        await onHunkAction(action, hunkId);
      } catch (error) {
        setOperationError(errorMessage(error));
      } finally {
        setPendingHunkId(null);
      }
    },
    [onHunkAction],
  );

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div className="scm-diff">
      <header className="scm-diff-header">
        <span className="scm-diff-path" title={path}>
          {path}
        </span>
        {group === "staged" ? <span className="scm-diff-badge">已暂存</span> : null}
        <button type="button" className="scm-diff-close" aria-label="关闭 diff" onClick={onClose}>
          <X />
        </button>
      </header>
      {operationError ? (
        <p className="scm-diff-operation-error" role="alert">
          {operationError}
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className="scm-diff-scroll"
        aria-label={`${path} 的完整差异`}
        role="region"
        tabIndex={0}
        style={
          {
            "--scm-diff-line-number-width": `${model.lineNumberDigits}ch`,
            "--scm-diff-content-width": `${model.maxColumns}ch`,
          } as CSSProperties
        }
      >
        <div className="scm-diff-virtual-space" style={{ height: `${virtualizer.getTotalSize() + 8}px` }}>
          {virtualItems.map((virtualRow) => {
            const line = model.lines[virtualRow.index];
            if (!line) return null;
            return (
              <div
                className="scm-diff-line"
                data-line-type={line.type}
                key={line.key}
                role="row"
                style={{ transform: `translateY(${virtualRow.start + 4}px)` }}
              >
                <DiffGutter line={line} group={group} pending={pendingHunkId !== null} onAction={runHunkAction} />
                <span className="scm-diff-line-text">{line.text === "" ? " " : line.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
