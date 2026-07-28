import type { JsonValue, PiNoticeMessage } from "../../../../../shared/contracts.ts";

export function notificationDetails(notice: PiNoticeMessage): JsonValue | undefined {
  if (notice.noticeType === "notification") return notice.extensionNotification?.details;
  return notice.content.type === "custom" ? notice.content.details : undefined;
}

export function notificationText(notice: PiNoticeMessage): string {
  if (notice.content.type === "text") return notice.content.text;
  if (notice.content.type !== "custom") return notice.title;
  return notice.content.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** 通知正文只作为自然语言回退；JSON 由各通知的专用 details renderer 负责展示。 */
export function notificationDisplayText(notice: PiNoticeMessage, fallback = "结构化通知"): string {
  const text = notificationText(notice)
    .replace(/```(?:json|acceptance-report|acceptance_report)\s*\n[\s\S]*?```/gi, "")
    .trim();
  const looksLikeJson = (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
  if (!text || looksLikeJson) return fallback;
  return text;
}

export function asRecord(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function numberValue(record: { [key: string]: JsonValue } | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

export function stringValue(record: { [key: string]: JsonValue } | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function stringList(record: { [key: string]: JsonValue } | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
