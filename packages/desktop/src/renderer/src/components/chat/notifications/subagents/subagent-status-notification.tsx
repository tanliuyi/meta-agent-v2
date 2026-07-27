import Network from "lucide-react/dist/esm/icons/network.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import { notificationText } from "../notification-data.ts";

const TITLES: Record<string, string> = {
  "subagents.info": "子代理通知",
  "subagents.warning": "子代理需要注意",
  "subagents.error": "子代理操作失败",
  "subagents.cancelled": "子代理运行已取消",
  "subagents-admin": "子代理配置",
  subagent_control_notice: "子代理需要处理",
  subagent_steering_notice: "子代理引导状态",
  "subagent-notify": "后台子代理完成",
  subagent_supervisor_request: "子代理请求协助",
};

export function SubagentStatusNotification({ notice, customType }: { notice: PiNoticeMessage; customType: string }) {
  const tone = customType === "subagents.error" ? "error" : customType === "subagents.info" ? "info" : "warning";
  return (
    <NotificationCard notice={notice} title={TITLES[customType] ?? "Subagents"} icon={<Network />} tone={tone}>
      <p className="builtin-notification-message">{notificationText(notice)}</p>
    </NotificationCard>
  );
}
