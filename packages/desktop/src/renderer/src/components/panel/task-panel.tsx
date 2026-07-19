import { usePiQueueCount, usePiThreadPhase } from "../../runtime/use-pi-thread-snapshot.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectActiveContextPercent, selectActiveExtensionStatuses } from "../../state/desktop-selectors.ts";

/** 以最小 selector 展示 active session 的运行与扩展状态。 */
export function TaskPanel() {
  const contextPercent = useDesktopSelector(selectActiveContextPercent);
  const statuses = useDesktopSelector(selectActiveExtensionStatuses);
  const phase = usePiThreadPhase();
  const queueCount = usePiQueueCount();
  return (
    <div className="task-panel">
      <h3>会话状态</h3>
      <dl>
        <div>
          <dt>运行</dt>
          <dd>{phase === "idle" ? "空闲" : "进行中"}</dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd>{contextPercent === null ? "--" : `${contextPercent.toFixed(1)}%`}</dd>
        </div>
        <div>
          <dt>队列</dt>
          <dd>{queueCount}</dd>
        </div>
        <div>
          <dt>压缩</dt>
          <dd>{phase === "compacting" ? "进行中" : "空闲"}</dd>
        </div>
      </dl>
      {Object.keys(statuses).length > 0 ? (
        <>
          <h3>扩展状态</h3>
          <ul>
            {Object.entries(statuses).map(([key, value]) => (
              <li key={key}>
                <span>{key}</span>
                <strong>{value}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
