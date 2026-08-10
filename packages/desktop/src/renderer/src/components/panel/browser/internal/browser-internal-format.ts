/** 本地时间格式化（内部页展示用）。 */
export function formatInternalDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${time}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
