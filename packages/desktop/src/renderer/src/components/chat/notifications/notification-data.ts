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
