import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import {
  asRecord,
  notificationDetails,
  notificationDisplayText,
  numberValue,
  stringList,
  stringValue,
} from "../notification-data.ts";
import { NotificationList } from "../notification-list.tsx";
import { NotificationStats } from "../notification-stats.tsx";

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
  const details = asRecord(notificationDetails(notice));
  const content = memoryContent(customType, details, notice);
  return (
    <NotificationCard
      notice={notice}
      title={TITLES[customType] ?? "Hermes Memory"}
      icon={<Brain />}
      tone={customType === "hermes-memory.error" ? "error" : "info"}
    >
      <p className="builtin-notification-message">{content.message}</p>
      {content.stats.length > 0 ? <NotificationStats items={content.stats} /> : null}
      <NotificationList items={content.items} />
      {content.body ? <pre className="builtin-notification-body">{content.body}</pre> : null}
      {content.action ? <p className="builtin-notification-action">{content.action}</p> : null}
    </NotificationCard>
  );
}

function memoryContent(
  customType: string,
  details: ReturnType<typeof asRecord>,
  notice: PiNoticeMessage,
): {
  message: string;
  stats: { label: string; value: string | number }[];
  items: string[];
  body?: string;
  action?: string;
} {
  if (customType === "hermes-memory.consolidation") {
    const phase = stringValue(details, "phase");
    const target = stringValue(details, "target");
    return {
      message:
        phase === "starting"
          ? "正在准备整理记忆。"
          : phase === "progress"
            ? `正在整理${target ? `：${target}` : "记忆"}。`
            : phase === "complete"
              ? "记忆整理完成。"
              : notificationDisplayText(notice),
      stats: compactStats([["目标", numberValue(details, "targetCount")]]),
      items: stringList(details, "results"),
    };
  }
  if (customType === "hermes-memory.insights") {
    return {
      message: "当前持久记忆概览。",
      stats: compactStats([
        ["个人记忆", numberValue(details, "memoryCount")],
        ["用户资料", numberValue(details, "userCount")],
        ["项目记忆", numberValue(details, "projectCount")],
      ]),
      items: [],
      ...(notificationDisplayText(notice, "") ? { body: notificationDisplayText(notice, "") } : {}),
      ...(stringValue(details, "projectName") ? { action: `当前项目：${stringValue(details, "projectName")}` } : {}),
    };
  }
  if (customType === "hermes-memory.skills") {
    return {
      message: "已读取可用的记忆技能。",
      stats: compactStats([["托管技能", numberValue(details, "managedCount")]]),
      items: textList(notificationDisplayText(notice)),
    };
  }
  if (customType === "hermes-memory.context-preview") {
    const mode = stringValue(details, "mode");
    return {
      message: mode === "policy-only" ? "当前仅注入记忆策略，不注入完整记忆正文。" : "当前使用完整记忆上下文注入。",
      stats: compactStats([
        ["模式", mode === "policy-only" ? "策略模式" : mode === "legacy-inject" ? "完整注入" : mode],
        ["策略", stringValue(details, "policyStyle")],
        ["上下文块", numberValue(details, "blockCount")],
      ]),
      items: [],
      ...(notificationDisplayText(notice, "") ? { body: notificationDisplayText(notice, "") } : {}),
    };
  }
  if (customType === "hermes-memory.guide") {
    return {
      message: "已打开记忆使用指南。",
      stats: compactStats([["章节", cleanGuideSection(stringValue(details, "section"))]]),
      items: [],
      ...(notificationDisplayText(notice, "") ? { body: notificationDisplayText(notice, "") } : {}),
    };
  }
  if (customType === "hermes-memory.project-list") {
    const projects = stringList(details, "projects");
    return {
      message: projects.length > 0 ? `找到 ${projects.length} 个项目记忆。` : "尚未找到项目记忆。",
      stats: compactStats([["项目", projects.length]]),
      items: projects,
      ...(notificationDisplayText(notice, "") ? { body: notificationDisplayText(notice, "") } : {}),
    };
  }
  if (customType === "hermes-memory.profile") {
    const count = numberValue(details, "entryCount") ?? 0;
    return {
      message: count > 0 ? "用户资料已存在，可继续补充或更新。" : "用户资料尚未建立。",
      stats: compactStats([["资料条目", count]]),
      items: [],
      ...(notificationDisplayText(notice, "") ? { body: notificationDisplayText(notice, "") } : {}),
    };
  }
  if (customType === "hermes-memory.updated") {
    return {
      message: updateMessage(stringValue(details, "source")),
      stats: [],
      items: [],
    };
  }
  if (customType === "hermes-memory.error") {
    return {
      message: stringValue(details, "message") ?? notificationDisplayText(notice, "记忆操作失败。"),
      stats: compactStats([["操作", operationLabel(stringValue(details, "operation"))]]),
      items: [],
      action: "请检查错误信息后重试。",
    };
  }
  return { message: notificationDisplayText(notice), stats: [], items: [] };
}

function compactStats(
  values: readonly (readonly [string, string | number | undefined])[],
): { label: string; value: string | number }[] {
  return values
    .filter((item): item is readonly [string, string | number] => item[1] !== undefined && item[1] !== "")
    .map(([label, value]) => ({ label, value }));
}

function textList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0 && !line.endsWith(":"));
}

function cleanGuideSection(section: string | undefined): string | undefined {
  return section?.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function updateMessage(source: string | undefined): string {
  if (source === "correction") return "已根据你的纠正更新持久记忆。";
  if (source === "background-review") return "后台审查已更新持久记忆。";
  return "持久记忆已更新。";
}

function operationLabel(operation: string | undefined): string | undefined {
  if (operation === "session-index") return "会话索引";
  if (operation === "markdown-sync") return "Markdown 同步";
  return operation;
}
