import type { PiNoticeMessage } from "../../../../../shared/contracts.ts";
import { MarkdownSyncNotification } from "./hermes-memory/markdown-sync-notification.tsx";
import { MemoryConsolidationNotification } from "./hermes-memory/memory-consolidation-notification.tsx";
import { MemoryContextPreviewNotification } from "./hermes-memory/memory-context-preview-notification.tsx";
import { MemoryErrorNotification } from "./hermes-memory/memory-error-notification.tsx";
import { MemoryGuideNotification } from "./hermes-memory/memory-guide-notification.tsx";
import { MemoryInsightsNotification } from "./hermes-memory/memory-insights-notification.tsx";
import { MemoryProfileNotification } from "./hermes-memory/memory-profile-notification.tsx";
import { MemorySkillsNotification } from "./hermes-memory/memory-skills-notification.tsx";
import { MemoryUpdatedNotification } from "./hermes-memory/memory-updated-notification.tsx";
import { ProjectMemoryListNotification } from "./hermes-memory/project-memory-list-notification.tsx";
import { SessionIndexNotification } from "./hermes-memory/session-index-notification.tsx";
import { SubagentCompletionNotification } from "./subagents/subagent-completion-notification.tsx";
import { SubagentControlNotification } from "./subagents/subagent-control-notification.tsx";
import { SubagentSlashResultNotification } from "./subagents/subagent-slash-result-notification.tsx";
import { SubagentSlashTextResultNotification } from "./subagents/subagent-slash-text-result-notification.tsx";
import { SubagentSteeringNotification } from "./subagents/subagent-steering-notification.tsx";
import { SubagentSupervisorRequestNotification } from "./subagents/subagent-supervisor-request-notification.tsx";
import { SubagentWatchdogNotification } from "./subagents/subagent-watchdog-notification.tsx";
import { SubagentsAdminNotification } from "./subagents/subagents-admin-notification.tsx";
import { SubagentsCancelledNotification } from "./subagents/subagents-cancelled-notification.tsx";
import { SubagentsErrorNotification } from "./subagents/subagents-error-notification.tsx";
import { SubagentsInfoNotification } from "./subagents/subagents-info-notification.tsx";
import { SubagentsWarningNotification } from "./subagents/subagents-warning-notification.tsx";

const BUILTIN_NOTIFICATION_TYPES = new Set([
  "hermes-memory.session-index",
  "hermes-memory.markdown-sync",
  "hermes-memory.consolidation",
  "hermes-memory.insights",
  "hermes-memory.skills",
  "hermes-memory.context-preview",
  "hermes-memory.guide",
  "hermes-memory.project-list",
  "hermes-memory.profile",
  "hermes-memory.updated",
  "hermes-memory.error",
  "subagents.info",
  "subagents.warning",
  "subagents.error",
  "subagents.cancelled",
  "subagents-admin",
  "subagent_control_notice",
  "subagent_steering_notice",
  "subagent-notify",
  "subagent_supervisor_request",
  "subagent_watchdog_warning",
  "subagent-slash-result",
  "subagent-slash-text-result",
]);

function notificationCustomType(notice: PiNoticeMessage): string | undefined {
  return notice.noticeType === "notification"
    ? notice.extensionNotification?.customType
    : notice.content.type === "custom"
      ? notice.content.customType
      : undefined;
}

export function hasBuiltinNotificationRenderer(notice: PiNoticeMessage): boolean {
  const customType = notificationCustomType(notice);
  return customType !== undefined && BUILTIN_NOTIFICATION_TYPES.has(customType);
}

export function BuiltinNotificationView({ notice }: { notice: PiNoticeMessage }) {
  switch (notificationCustomType(notice)) {
    case "hermes-memory.session-index":
      return <SessionIndexNotification notice={notice} />;
    case "hermes-memory.markdown-sync":
      return <MarkdownSyncNotification notice={notice} />;
    case "hermes-memory.consolidation":
      return <MemoryConsolidationNotification notice={notice} />;
    case "hermes-memory.insights":
      return <MemoryInsightsNotification notice={notice} />;
    case "hermes-memory.skills":
      return <MemorySkillsNotification notice={notice} />;
    case "hermes-memory.context-preview":
      return <MemoryContextPreviewNotification notice={notice} />;
    case "hermes-memory.guide":
      return <MemoryGuideNotification notice={notice} />;
    case "hermes-memory.project-list":
      return <ProjectMemoryListNotification notice={notice} />;
    case "hermes-memory.profile":
      return <MemoryProfileNotification notice={notice} />;
    case "hermes-memory.updated":
      return <MemoryUpdatedNotification notice={notice} />;
    case "hermes-memory.error":
      return <MemoryErrorNotification notice={notice} />;
    case "subagents.info":
      return <SubagentsInfoNotification notice={notice} />;
    case "subagents.warning":
      return <SubagentsWarningNotification notice={notice} />;
    case "subagents.error":
      return <SubagentsErrorNotification notice={notice} />;
    case "subagents.cancelled":
      return <SubagentsCancelledNotification notice={notice} />;
    case "subagents-admin":
      return <SubagentsAdminNotification notice={notice} />;
    case "subagent_control_notice":
      return <SubagentControlNotification notice={notice} />;
    case "subagent_steering_notice":
      return <SubagentSteeringNotification notice={notice} />;
    case "subagent-notify":
      return <SubagentCompletionNotification notice={notice} />;
    case "subagent_supervisor_request":
      return <SubagentSupervisorRequestNotification notice={notice} />;
    case "subagent_watchdog_warning":
      return <SubagentWatchdogNotification notice={notice} />;
    case "subagent-slash-result":
      return <SubagentSlashResultNotification notice={notice} />;
    case "subagent-slash-text-result":
      return <SubagentSlashTextResultNotification notice={notice} />;
    default:
      return null;
  }
}
