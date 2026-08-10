import DownloadIcon from "lucide-react/dist/esm/icons/download.mjs";
import FileIcon from "lucide-react/dist/esm/icons/file.mjs";
import FolderOpenIcon from "lucide-react/dist/esm/icons/folder-open.mjs";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { ReactNode } from "react";
import type { BrowserDataSnapshot, PersistedDownload } from "../../../../../../shared/browser-data-contracts.ts";
import { BrowserInternalEmpty } from "./browser-internal-empty.tsx";
import { formatInternalDateTime } from "./browser-internal-format.ts";
import { BrowserInternalPageHeader } from "./browser-internal-header.tsx";

const DOWNLOAD_STATE_LABELS: Record<PersistedDownload["state"], string> = {
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function BrowserDownloadsPage({
  snapshot,
  onReveal,
  onOpenFile,
  onOpenFolder,
  onClearAll,
}: {
  snapshot: BrowserDataSnapshot | null;
  onReveal: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onClearAll: () => void;
}): ReactNode {
  const downloads = snapshot?.downloads ?? [];
  return (
    <div className="browser-internal-page">
      <BrowserInternalPageHeader
        title="下载"
        actions={
          <>
            <button type="button" className="browser-internal-button" onClick={onOpenFolder}>
              <FolderOpenIcon size={13} aria-hidden="true" />
              打开下载文件夹
            </button>
            {downloads.length > 0 ? (
              <button type="button" className="browser-internal-button" onClick={onClearAll}>
                <Trash2Icon size={13} aria-hidden="true" />
                清除全部
              </button>
            ) : null}
          </>
        }
      />
      {!snapshot ? (
        <BrowserInternalEmpty text="正在加载…" />
      ) : downloads.length === 0 ? (
        <BrowserInternalEmpty text="暂无下载记录" />
      ) : (
        <ul className="browser-internal-list">
          {downloads.map((item) => (
            <li key={item.id} className="browser-download-row">
              <span className="browser-download-icon" aria-hidden="true">
                {item.state === "completed" ? <FileIcon size={16} /> : <DownloadIcon size={16} />}
              </span>
              <span className="browser-download-main">
                <span className="browser-download-filename" title={item.filename}>
                  {item.filename}
                </span>
                <span className="browser-download-url" title={item.url}>
                  {item.url}
                </span>
                <span className="browser-download-meta">
                  {DOWNLOAD_STATE_LABELS[item.state]}
                  {formatBytes(item.totalBytes) ? ` · ${formatBytes(item.totalBytes)}` : ""}
                  {item.endedAt !== null ? ` · ${formatInternalDateTime(item.endedAt)}` : ""}
                </span>
              </span>
              <span className="browser-download-actions">
                {item.path ? (
                  <>
                    <button
                      type="button"
                      className="browser-internal-button"
                      title="在文件夹中显示"
                      aria-label={`在文件夹中显示 ${item.filename}`}
                      onClick={() => onReveal(item.path ?? "")}
                    >
                      <FolderOpenIcon size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="browser-internal-button"
                      title="打开文件"
                      aria-label={`打开 ${item.filename}`}
                      onClick={() => onOpenFile(item.path ?? "")}
                    >
                      <FileIcon size={13} aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
