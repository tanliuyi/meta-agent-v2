import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import FileDiff from "lucide-react/dist/esm/icons/file-diff.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import { useMemo, useState } from "react";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import type {
  PiCheckpointNoticeDetails,
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreResult,
} from "../../../../../../shared/pi-rewind-contracts.ts";
import { CheckpointFile } from "./checkpoint-file.tsx";
import { parseCheckpointNotice } from "./checkpoint-notification-data.ts";

type RestoreState = "idle" | "restoring" | "restored" | "error";
export type CheckpointDiffLoader = (
  details: PiCheckpointNoticeDetails,
  path: string,
) => Promise<SessionCheckpointDiffResult>;

export function CheckpointNotificationView({
  notice,
  canRestore = true,
  loadDiff,
  onRestore,
  initialExpandedPaths,
  initialDiffs,
}: {
  notice: PiNoticeMessage;
  canRestore?: boolean;
  loadDiff?: CheckpointDiffLoader;
  onRestore?: (details: PiCheckpointNoticeDetails) => Promise<SessionCheckpointRestoreResult>;
  initialExpandedPaths?: readonly string[];
  initialDiffs?: Readonly<Record<string, SessionCheckpointDiffResult>>;
}) {
  const details = useMemo(() => parseCheckpointNotice(notice), [notice]);
  const [expandedPath, setExpandedPath] = useState<string | null>(() => initialExpandedPaths?.[0] ?? null);
  const [diffs, setDiffs] = useState<Readonly<Record<string, SessionCheckpointDiffResult>>>(() => ({
    ...initialDiffs,
  }));
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [diffErrors, setDiffErrors] = useState<Readonly<Record<string, string>>>(() => ({}));
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [restoreState, setRestoreState] = useState<RestoreState>("idle");
  const [restoreError, setRestoreError] = useState<string>();

  if (!details) {
    return (
      <section className="checkpoint-card" data-state="invalid">
        <header className="checkpoint-header">
          <span className="checkpoint-icon" aria-hidden="true">
            <FileDiff />
          </span>
          <strong>Checkpoint 数据不可用</strong>
        </header>
      </section>
    );
  }

  const toggleFile = (path: string) => {
    if (expandedPath === path) {
      setExpandedPath(null);
      return;
    }
    setExpandedPath(path);
    if (diffs[path] || loadingPaths.has(path) || !loadDiff) return;
    setLoadingPaths((current) => new Set(current).add(path));
    setDiffErrors((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    void loadDiff(details, path)
      .then(
        (diff) => setDiffs((current) => ({ ...current, [path]: diff })),
        (error: unknown) =>
          setDiffErrors((current) => ({
            ...current,
            [path]: error instanceof Error ? error.message : String(error),
          })),
      )
      .finally(() => {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      });
  };
  const restore = async () => {
    if (!canRestore || !onRestore || restoreState === "restoring" || restoreState === "restored") return;
    setRestoreState("restoring");
    setRestoreError(undefined);
    try {
      await onRestore(details);
      setRestoreState("restored");
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : String(error));
      setRestoreState("error");
    }
  };

  return (
    <section className="checkpoint-card" data-state={restoreState}>
      <header className="checkpoint-header">
        <span className="checkpoint-icon" aria-hidden="true">
          <FileDiff />
        </span>
        <div className="checkpoint-summary">
          <strong>{details.reason === "recovery" ? "检测到中断的撤销" : `已编辑 ${details.fileCount} 个文件`}</strong>
          <span className="checkpoint-total" aria-label={`新增 ${details.additions} 行，删除 ${details.deletions} 行`}>
            <span data-tone="add">+{details.additions}</span>
            <span data-tone="delete">-{details.deletions}</span>
          </span>
        </div>
        <div className="checkpoint-actions">
          <Button
            className="checkpoint-undo"
            variant="ghost"
            size="sm"
            aria-haspopup="dialog"
            disabled={!canRestore || !onRestore || restoreState === "restoring" || restoreState === "restored"}
            onClick={() => setConfirmRestoreOpen(true)}
          >
            <RotateCcw aria-hidden="true" />
            {restoreState === "restoring"
              ? "恢复中"
              : restoreState === "restored"
                ? "已恢复"
                : details.reason === "recovery"
                  ? "恢复"
                  : "撤销"}
          </Button>
        </div>
      </header>
      <div className="checkpoint-files">
        {details.files.map((file) => (
          <CheckpointFile
            key={file.path}
            file={file}
            expanded={expandedPath === file.path}
            diff={diffs[file.path]}
            loading={loadingPaths.has(file.path)}
            error={diffErrors[file.path]}
            onToggle={() => toggleFile(file.path)}
          />
        ))}
      </div>
      {details.truncated ? (
        <p className="checkpoint-truncated">仅显示前 {details.files.length} 个文件，撤销仍使用完整 checkpoint。</p>
      ) : null}
      {restoreError ? (
        <p className="checkpoint-error" role="alert">
          {restoreError}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmRestoreOpen}
        title={details.reason === "recovery" ? "恢复中断前的工作区？" : "撤销本轮文件修改？"}
        description={`将工作区和暂存区恢复到此轮开始前的状态，影响 ${details.fileCount} 个文件。Git HEAD 不会移动；同一 Git 仓库中已打开的集成终端将关闭。`}
        confirmLabel={details.reason === "recovery" ? "确认恢复" : "确认撤销"}
        onOpenChange={setConfirmRestoreOpen}
        onConfirm={() => void restore()}
      />
    </section>
  );
}
