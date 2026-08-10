import HistoryIcon from "lucide-react/dist/esm/icons/history.mjs";
import Trash2Icon from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type { BrowserDataSnapshot, PersistedHistoryEntry } from "../../../../../../shared/browser-data-contracts.ts";
import { BrowserInternalEmpty } from "./browser-internal-empty.tsx";
import { formatInternalDateTime } from "./browser-internal-format.ts";
import { BrowserInternalPageHeader } from "./browser-internal-header.tsx";

/**
 * 浏览历史页：全部历史记录按天分组（参考 chrome://history），
 * 支持跳转与删除单条。
 */

interface HistoryGroup {
  label: string;
  entries: PersistedHistoryEntry[];
}

function groupByDay(entries: PersistedHistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const label =
      key === todayKey
        ? "今天"
        : key === yesterdayKey
          ? "昨天"
          : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

export function BrowserHistoryPage({
  snapshot,
  onOpenUrl,
  onDeleteEntry,
  onClearAll,
}: {
  snapshot: BrowserDataSnapshot | null;
  onOpenUrl: (url: string) => void;
  onDeleteEntry: (url: string, timestamp: number) => void;
  onClearAll: () => void;
}): ReactNode {
  const groups = useMemo(() => groupByDay(snapshot?.history ?? []), [snapshot]);
  if (!snapshot) {
    return (
      <div className="browser-internal-page">
        <BrowserInternalPageHeader title="浏览历史" />
        <BrowserInternalEmpty text="正在加载…" />
      </div>
    );
  }
  return (
    <div className="browser-internal-page">
      <BrowserInternalPageHeader
        title="浏览历史"
        actions={
          snapshot.history.length > 0 ? (
            <button type="button" className="browser-internal-button" onClick={onClearAll}>
              <Trash2Icon size={13} aria-hidden="true" />
              清除全部
            </button>
          ) : null
        }
      />
      {groups.length === 0 ? (
        <BrowserInternalEmpty text="暂无浏览历史" />
      ) : (
        <div className="browser-internal-list">
          {groups.map((group) => (
            <section key={group.label} className="browser-history-group">
              <h3 className="browser-history-group-title">{group.label}</h3>
              <ul className="browser-internal-list">
                {group.entries.map((entry) => (
                  <li key={`${entry.url}-${entry.timestamp}`} className="browser-history-row">
                    <button
                      type="button"
                      className="browser-history-row-main"
                      title={entry.url}
                      onClick={() => onOpenUrl(entry.url)}
                    >
                      <HistoryIcon size={14} aria-hidden="true" />
                      <span className="browser-history-row-text">
                        <span className="browser-history-row-title">{entry.title || entry.url}</span>
                        <span className="browser-history-row-url">{entry.url}</span>
                      </span>
                    </button>
                    <span className="browser-history-row-time">{formatInternalDateTime(entry.timestamp)}</span>
                    <button
                      type="button"
                      className="browser-history-row-delete"
                      aria-label={`删除 ${entry.title || entry.url}`}
                      title="从历史记录中删除"
                      onClick={() => onDeleteEntry(entry.url, entry.timestamp)}
                    >
                      <Trash2Icon size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
