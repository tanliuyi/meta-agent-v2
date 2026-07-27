import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import { notificationText } from "../notification-data.ts";

const TITLES: Record<string, string> = {
  "hermes-memory.consolidation": "记忆整理",
  "hermes-memory.insights": "记忆概述",
  "hermes-memory.skills": "记忆技能",
  "hermes-memory.context-preview": "记忆上下文",
  "hermes-memory.guide": "记忆使用指南",
  "hermes-memory.project-list": "项目记忆",
  "hermes-memory.profile": "用户记忆资料",
  "hermes-memory.updated": "记忆已更新",
  "hermes-memory.error": "记忆操作失败",
};

export function MemoryOperationNotification({ notice, customType }: { notice: PiNoticeMessage; customType: string }) {
  return (
    <NotificationCard notice={notice} title={TITLES[customType] ?? "Hermes Memory"} icon={<Brain />}>
      <p className="builtin-notification-message">{notificationText(notice)}</p>
    </NotificationCard>
  );
}
