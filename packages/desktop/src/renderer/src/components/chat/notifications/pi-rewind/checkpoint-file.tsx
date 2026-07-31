import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import type {
  PiCheckpointFileDiff,
  SessionCheckpointDiffResult,
} from "../../../../../../shared/pi-rewind-contracts.ts";
import { CheckpointDiff } from "./checkpoint-diff.tsx";

export function CheckpointFile({
  file,
  expanded,
  diff,
  loading,
  error,
  onToggle,
}: {
  file: PiCheckpointFileDiff;
  expanded: boolean;
  diff?: SessionCheckpointDiffResult;
  loading: boolean;
  error?: string;
  onToggle(): void;
}) {
  return (
    <div className="checkpoint-file" data-state={expanded ? "open" : "closed"}>
      <button className="checkpoint-file-trigger" type="button" aria-expanded={expanded} onClick={onToggle}>
        <ChevronRight className="checkpoint-file-chevron" aria-hidden="true" />
        <span className="checkpoint-file-path">{file.path}</span>
        {file.additions === null || file.deletions === null ? (
          <span className="checkpoint-file-binary">二进制</span>
        ) : (
          <span className="checkpoint-file-counts" aria-label={`新增 ${file.additions} 行，删除 ${file.deletions} 行`}>
            <span data-tone="add">+{file.additions}</span>
            <span data-tone="delete">-{file.deletions}</span>
          </span>
        )}
      </button>
      {expanded ? (
        <div className="checkpoint-file-diff">
          {diff?.patch ? <CheckpointDiff patch={diff.patch} /> : null}
          {loading ? <p className="checkpoint-diff-unavailable">正在读取 diff...</p> : null}
          {!loading && !diff && !error ? <p className="checkpoint-diff-unavailable">无法读取 diff。</p> : null}
          {diff && !diff.patch ? <p className="checkpoint-diff-unavailable">此文件没有可显示的文本 diff。</p> : null}
          {diff?.truncated ? <p className="checkpoint-diff-unavailable">Diff 已截断。</p> : null}
          {error ? (
            <p className="checkpoint-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
