import type { PiNoticeContent, PiNoticeMessage } from "../../../../shared/contracts.ts";

export function noticeTitle(notice: PiNoticeMessage): string {
  if (notice.noticeType === "bash") return "终端命令";
  if (notice.noticeType === "branch-summary") return "分支摘要";
  return notice.title;
}

export function isPiNotice(value: unknown): value is PiNoticeMessage {
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "notice" ||
    !("noticeType" in value) ||
    !isPiNoticeType(value.noticeType) ||
    !("content" in value) ||
    !isPiNoticeContent(value.content)
  ) {
    return false;
  }

  if (value.noticeType !== "notification") return true;
  return (
    value.content.type === "text" &&
    "notificationType" in value &&
    (value.notificationType === "info" || value.notificationType === "warning" || value.notificationType === "error")
  );
}

function isPiNoticeType(value: unknown): value is PiNoticeMessage["noticeType"] {
  return (
    value === "bash" ||
    value === "custom" ||
    value === "compaction" ||
    value === "branch-summary" ||
    value === "notification"
  );
}

function isPiNoticeContent(value: unknown): value is PiNoticeContent {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;

  if (value.type === "text") return "text" in value && typeof value.text === "string";
  if (value.type === "command") {
    return (
      "command" in value &&
      typeof value.command === "string" &&
      "output" in value &&
      typeof value.output === "string" &&
      "cancelled" in value &&
      typeof value.cancelled === "boolean"
    );
  }
  if (value.type !== "custom" || !("content" in value) || !Array.isArray(value.content)) return false;

  return value.content.every(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      "type" in part &&
      ((part.type === "text" && "text" in part && typeof part.text === "string") ||
        (part.type === "image" &&
          "data" in part &&
          typeof part.data === "string" &&
          "mimeType" in part &&
          typeof part.mimeType === "string")),
  );
}
