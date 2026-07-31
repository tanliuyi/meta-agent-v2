import { useEffect, useRef } from "react";
import { useSessionCache, useSessionCacheRecords } from "../../state/session-cache-context.tsx";
import type { SidebarSessionTab } from "../../state/sidebar-session-context.tsx";
import { ChatThread } from "../chat/chat-thread.tsx";
import { SessionProvider } from "../session-provider.tsx";

interface SidebarSessionContentProps {
  tab: SidebarSessionTab;
  /** 关闭 tab（由 workbench-panel 负责）。 */
  onClose(tab: SidebarSessionTab): void;
}

/**
 * workbench-panel 中侧边栏 tab 的会话内容：与 chat-workspace/workspace-row
 * session-surface 一致（无 topbar），且作为 active provider 与主工作区能力一致。
 */
export function SidebarSessionContent({ tab, onClose }: SidebarSessionContentProps) {
  const cache = useSessionCache();
  const records = useSessionCacheRecords();
  const record = records.find((candidate) => candidate.key === tab.key) ?? null;

  // 挂载期间持有一席，确保主工作区导航切换不会 detach 本会话；卸载时释放。
  useEffect(() => {
    cache.retain(tab.key);
    return () => cache.release(tab.key);
  }, [cache, tab.key]);

  // tab 激活时确保 attachment；临时失败时重试，永久失败（retire/error）停止。
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const attach = (): void => {
      void cache.ensureAttached({ projectId: tab.projectId, threadId: tab.threadId }).catch(() => {
        if (disposed) return;
        if (cache.get(tab.key)?.stores.connection.getSnapshot() === "error") return;
        timer = window.setTimeout(attach, 600);
      });
    };
    attach();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cache, tab]);

  // 会话被归档/删除（record 被 retire 移除）时自动关闭对应 tab。
  const seenRecordKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (record) {
      seenRecordKeyRef.current = tab.key;
      return;
    }
    if (seenRecordKeyRef.current === tab.key && cache.get(tab.key) === undefined) onClose(tab);
  }, [cache, onClose, record, tab]);

  if (!record) {
    return <div className="panel-content sidebar-session-loading">正在同步会话…</div>;
  }
  return (
    <div className="panel-content">
      <SessionProvider key={record.key} record={record} active>
        <div className="workspace-row session-surface sidebar-session-row" data-session-key={record.key}>
          <main className="chat-workspace">
            <ChatThread />
          </main>
        </div>
      </SessionProvider>
    </div>
  );
}
