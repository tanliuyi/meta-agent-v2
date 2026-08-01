import { useSessionControlSelector, useSessionTimelineSelector } from "../../session-context.tsx";

/** Session diagnostics derive from the record's timeline and control stores. */
export function TaskPanel() {
  const contextPercent = useSessionControlSelector((control) => control?.context?.percent);
  const statuses = useSessionControlSelector((control) => control?.extensionHost.statuses ?? EMPTY_STATUSES);
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  const queueLength = useSessionTimelineSelector((timeline) => timeline.queue.length);
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
          <dd>{contextPercent === null || contextPercent === undefined ? "--" : `${contextPercent.toFixed(1)}%`}</dd>
        </div>
        <div>
          <dt>队列</dt>
          <dd>{queueLength}</dd>
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

const EMPTY_STATUSES: Readonly<Record<string, string>> = {};
