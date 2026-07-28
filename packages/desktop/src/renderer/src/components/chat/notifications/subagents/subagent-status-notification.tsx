import Network from "lucide-react/dist/esm/icons/network.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import {
  asRecord,
  notificationDetails,
  notificationDisplayText,
  numberValue,
  stringValue,
} from "../notification-data.ts";
import { NotificationStats } from "../notification-stats.tsx";

const TITLES: Record<string, string> = {
  "subagents.info": "子代理通知",
  "subagents.warning": "子代理需要注意",
  "subagents.error": "子代理操作失败",
  "subagents.cancelled": "子代理运行已取消",
  "subagents-admin": "子代理配置",
  subagent_control_notice: "子代理需要处理",
  subagent_steering_notice: "子代理引导状态",
  subagent_supervisor_request: "子代理请求协助",
};

export function SubagentStatusNotification({ notice, customType }: { notice: PiNoticeMessage; customType: string }) {
  const details = asRecord(notificationDetails(notice));
  const content = statusContent(customType, details, notice);
  const tone =
    customType === "subagents.error" || (customType === "subagent_steering_notice" && content.state === "失败")
      ? "error"
      : customType === "subagents.info"
        ? "info"
        : "warning";
  return (
    <NotificationCard notice={notice} title={TITLES[customType] ?? "Subagents"} icon={<Network />} tone={tone}>
      <p className="builtin-notification-message">{content.message}</p>
      {content.stats.length > 0 ? <NotificationStats items={content.stats} /> : null}
      {content.action ? <p className="builtin-notification-action">{content.action}</p> : null}
    </NotificationCard>
  );
}

function statusContent(
  customType: string,
  details: ReturnType<typeof asRecord>,
  notice: PiNoticeMessage,
): { message: string; state?: string; stats: { label: string; value: string | number }[]; action?: string } {
  if (customType === "subagent_control_notice") {
    const event = asRecord(details?.event);
    const stats = compactStats([
      ["代理", stringValue(event, "agent")],
      ["运行", stringValue(event, "runId")],
      ["当前工具", stringValue(event, "currentTool")],
      ["轮次", numberValue(event, "turns")],
      ["工具调用", numberValue(event, "toolCount")],
    ]);
    return {
      message: stringValue(event, "message") ?? notificationDisplayText(notice, "子代理需要人工处理。"),
      stats,
      action: controlReason(stringValue(event, "reason")),
    };
  }
  if (customType === "subagent_steering_notice") {
    const state = steeringState(stringValue(details, "state"));
    return {
      message: stringValue(details, "message") ?? notificationDisplayText(notice, "引导请求状态已更新。"),
      state,
      stats: compactStats([
        ["状态", state],
        ["运行", stringValue(details, "runId")],
        ["请求", stringValue(details, "requestId")],
      ]),
      action: "再次发送修正前，请先检查该运行的最新状态。",
    };
  }
  if (customType === "subagent_supervisor_request") {
    const expectsReply = details?.expectsReply === true;
    return {
      message: notificationDisplayText(notice, "子代理发来了主管请求。"),
      stats: compactStats([
        ["代理", stringValue(details, "agent")],
        ["原因", supervisorReason(stringValue(details, "reason"))],
        ["运行", stringValue(details, "runId")],
        ["子任务", childIndex(details)],
      ]),
      ...(expectsReply ? { action: "此请求正在等待回复。" } : {}),
    };
  }
  return {
    message: notificationDisplayText(notice),
    stats: compactStats([
      ["代理", stringValue(details, "agent")],
      ["运行", stringValue(details, "runId")],
      ["操作", stringValue(details, "action")],
    ]),
  };
}

function compactStats(
  values: readonly (readonly [string, string | number | undefined])[],
): { label: string; value: string | number }[] {
  return values
    .filter((item): item is readonly [string, string | number] => item[1] !== undefined && item[1] !== "")
    .map(([label, value]) => ({ label, value }));
}

function childIndex(details: ReturnType<typeof asRecord>): number | undefined {
  const index = numberValue(details, "childIndex");
  return index === undefined ? undefined : index + 1;
}

function controlReason(reason: string | undefined): string | undefined {
  if (reason === "tool_failures") return "连续工具调用失败，需要检查执行方式。";
  if (reason === "completion_guard") return "完成条件未满足，需要确认后续处理。";
  if (reason === "supervisor_request") return "子代理主动请求主管协助。";
  if (reason === "idle") return "运行长时间无活动，需要检查状态。";
  if (reason === "time_threshold") return "运行时间超过关注阈值。";
  if (reason === "turn_threshold") return "执行轮次超过关注阈值。";
  if (reason === "token_threshold") return "Token 使用超过关注阈值。";
  return undefined;
}

function steeringState(state: string | undefined): string {
  if (state === "recovered") return "已恢复";
  if (state === "partial") return "部分送达";
  return "失败";
}

function supervisorReason(reason: string | undefined): string | undefined {
  if (reason === "clarification") return "需要澄清";
  if (reason === "permission") return "需要授权";
  if (reason === "blocked") return "执行受阻";
  if (reason === "question") return "提出问题";
  return reason;
}
