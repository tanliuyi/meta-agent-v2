import {
  useSessionConnection,
  useSessionControl,
  useSessionIdentity,
  useSessionTimelineSelector,
} from "../session-context.tsx";
import { formatTokenCount } from "./message/usage-format.ts";

const connectionLabels = {
  attaching: "正在连接",
  ready: "已连接",
  recovering: "正在恢复",
  error: "连接失败",
} as const;

const phaseLabels = {
  idle: "空闲",
  running: "运行中",
  retrying: "正在重试",
  compacting: "正在压缩",
  "tree-navigation": "正在切换分支",
} as const;

const thinkingLabels = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
} as const;

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatDateTime(timestamp: number | null): string {
  if (timestamp === null) return "未知";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "未知" : dateTimeFormatter.format(date);
}

/** 当前主会话的只读基本信息。 */
export function SessionInfo({ open }: { open: boolean }) {
  const control = useSessionControl();
  const connection = useSessionConnection();
  const identity = useSessionIdentity();
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  const messageCount = useSessionTimelineSelector(
    (timeline) => timeline.nodes.filter((node) => node.kind === "user" || node.kind === "assistant").length,
  );
  const createdAt = useSessionTimelineSelector((timeline) => timeline.nodes[0]?.createdAt ?? null);

  if (!control) return null;

  const context = control.context;
  const contextText = context
    ? `${context.tokens === null ? "未知" : formatTokenCount(context.tokens)} / ${formatTokenCount(context.contextWindow)}${context.percent === null ? "" : ` (${Math.round(context.percent)}%)`}`
    : "暂无数据";
  const modelText = control.model ? `${control.model.name} (${control.model.provider}/${control.model.id})` : "未选择";

  return (
    <aside
      id="session-info-panel"
      className="session-info-panel"
      data-open={open}
      aria-hidden={!open}
      aria-labelledby="session-info-title"
    >
      <header className="session-info-header">
        <div>
          <span className="session-info-eyebrow">SESSION</span>
          <h2 id="session-info-title">会话信息</h2>
        </div>
        <span className="session-info-status" data-state={connection}>
          <span aria-hidden="true" />
          {connectionLabels[connection]} · {phaseLabels[phase]}
        </span>
      </header>

      <dl className="session-info-list">
        <div>
          <dt>模型</dt>
          <dd title={modelText}>{modelText}</dd>
        </div>
        <div>
          <dt>思考级别</dt>
          <dd>{thinkingLabels[control.thinkingLevel]}</dd>
        </div>
        <div>
          <dt>上下文</dt>
          <dd>{contextText}</dd>
        </div>
        <div>
          <dt>消息</dt>
          <dd>{messageCount} 条</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatDateTime(createdAt)}</dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{formatDateTime(control.updatedAt)}</dd>
        </div>
      </dl>

      <section className="session-info-section" aria-labelledby="session-info-workspace-title">
        <h3 id="session-info-workspace-title">工作区</h3>
        <dl className="session-info-list session-info-list-technical">
          <div>
            <dt>目录</dt>
            <dd title={control.cwd}>{control.cwd}</dd>
          </div>
          <div>
            <dt>会话 ID</dt>
            <dd title={identity.threadId}>{identity.threadId}</dd>
          </div>
          <div>
            <dt>项目 ID</dt>
            <dd title={identity.projectId}>{identity.projectId}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}
