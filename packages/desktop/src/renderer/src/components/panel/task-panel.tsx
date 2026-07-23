import { useSessionControl, useSessionTimeline } from "../session-context.tsx";

/** Session diagnostics derive from the record's timeline and control stores. */
export function TaskPanel() {
  const control = useSessionControl();
  const timeline = useSessionTimeline();
  const statuses = control?.extensionHost.statuses ?? {};
  return (
    <div className="task-panel">
      <h3>会话状态</h3>
      <dl>
        <div>
          <dt>运行</dt>
          <dd>{timeline.phase === "idle" ? "空闲" : "进行中"}</dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd>
            {control?.context?.percent === null || control?.context?.percent === undefined
              ? "--"
              : `${control.context.percent.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>队列</dt>
          <dd>{timeline.queue.length}</dd>
        </div>
        <div>
          <dt>压缩</dt>
          <dd>{timeline.phase === "compacting" ? "进行中" : "空闲"}</dd>
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
