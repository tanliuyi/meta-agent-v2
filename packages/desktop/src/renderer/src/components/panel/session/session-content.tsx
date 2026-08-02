import { useEffect, useRef } from "react";
import type { WorkbenchSessionTab } from "../../../../../shared/contracts.ts";
import { createCompletedMarkerAutoClear } from "../../../state/completed-marker-auto-clear.ts";
import { dispatchDesktop } from "../../../state/desktop-store.ts";
import { useDesktopStore } from "../../../state/desktop-store-context.tsx";
import { useSessionCache, useSessionCacheRecords } from "../../../state/session-cache-context.tsx";
import { ChatThread } from "../../chat/chat-thread.tsx";
import { SessionProvider } from "../../session-provider.tsx";

interface SessionContentProps {
  tab: WorkbenchSessionTab;
  /** 关闭 tab（由 workbench-panel 负责）。 */
  onClose(tab: WorkbenchSessionTab): void;
}

/**
 * workbench-panel 中侧边栏 tab 的会话内容：与 chat-workspace/workspace-row
 * session-surface 一致（无 topbar），且作为 active provider 与主工作区能力一致。
 */
export function SessionContent({ tab, onClose }: SessionContentProps) {
  const cache = useSessionCache();
  const records = useSessionCacheRecords();
  const desktopStore = useDesktopStore();
  const record = records.find((candidate) => candidate.key === tab.key) ?? null;

  // 挂载期间持有一席，确保主工作区导航切换不会 detach 本会话；卸载时释放。
  useEffect(() => {
    cache.retain(tab.key);
    return () => cache.release(tab.key);
  }, [cache, tab.key]);

  // tab 激活时确保 record 存在并发起初始 attach（cache.ensure 内部 fire-and-forget）。
  // 连接恢复（含初始 attach 失败后的重试）由嵌套 SessionProvider 的唯一恢复循环负责：
  // 同一 mounted active session 只允许一个 UI 恢复所有者，避免一次 recovering 转换
  // 由多个订阅者并发 recover 触发多次替换 attach（会话被删除时由下方效果自动关闭 tab）。
  useEffect(() => {
    cache.ensure({ projectId: tab.projectId, threadId: tab.threadId });
  }, [cache, tab]);

  // 本 tab 处于活动可见状态时持续清除运行完成标记（与主路由“打开会话即视为已查看”一致）。
  useEffect(() => {
    const autoClear = createCompletedMarkerAutoClear({
      store: desktopStore,
      projectId: tab.projectId,
      threadId: tab.threadId,
      dispatchViewed: () =>
        dispatchDesktop(desktopStore, { type: "thread-viewed", projectId: tab.projectId, threadId: tab.threadId }),
    });
    return () => autoClear.dispose();
  }, [desktopStore, tab.projectId, tab.threadId]);

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
