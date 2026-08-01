import type { DesktopStore } from "./desktop-store.ts";

/**
 * 持续清除活动会话的运行完成标记：只要会话可见，其 completed 标记每次被置位
 * （如“正在查看时运行结束”）都会被立即清除，与主路由打开会话即视为已查看一致。
 * 卸载（dispose）后不再清除。
 */
export function createCompletedMarkerAutoClear(input: {
  store: DesktopStore;
  projectId: string;
  threadId: string;
  dispatchViewed(): void;
}): { dispose(): void } {
  const sync = (): void => {
    const completed =
      input.store
        .getState()
        .threadCatalogs[input.projectId]?.some(({ id, completed }) => id === input.threadId && completed === true) ===
      true;
    if (completed) input.dispatchViewed();
  };
  const unsubscribe = input.store.subscribe(sync);
  sync();
  return { dispose: unsubscribe };
}
