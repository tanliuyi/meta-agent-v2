/** assistant 消息元数据的防御解析与紧凑展示，供动作栏统计文本使用。 */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 紧凑 token 计数（999 / 12.3k / 1.2M），舍入进位时提升单位。 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) {
    const scaled = (tokens / 1_000).toFixed(1).replace(/\.0$/, "");
    return scaled === "1000" ? "1M" : `${scaled}k`;
  }
  return `${tokens}`;
}

/** 美元费用；极小正数统一为 <$0.0001。 */
export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

const messageTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 本地 HH:mm；无效 timestamp 返回 null，不渲染 Invalid Date。 */
export function formatMessageTime(timestamp: number): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return messageTimeFormatter.format(date);
}

/** token 计数字段：必须为有限非负 number，否则返回 null。 */
function parseTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 从 pi.usage 提取统计文本；五个 token 字段任一畸形时返回 null，费用非有限正数时省略费用段。 */
export function formatPiUsageSummary(usage: unknown): string | null {
  if (!isRecord(usage)) return null;
  const totalTokens = parseTokenCount(usage.totalTokens);
  const input = parseTokenCount(usage.input);
  const output = parseTokenCount(usage.output);
  const cacheRead = parseTokenCount(usage.cacheRead);
  const cacheWrite = parseTokenCount(usage.cacheWrite);
  if (totalTokens === null || input === null || output === null || cacheRead === null || cacheWrite === null) {
    return null;
  }
  const parts = [
    `${formatTokenCount(totalTokens)} tokens（输入 ${formatTokenCount(input)} / 输出 ${formatTokenCount(output)} / 缓存读 ${formatTokenCount(cacheRead)} / 缓存写 ${formatTokenCount(cacheWrite)}）`,
  ];
  const cost = isRecord(usage.cost) ? usage.cost.total : undefined;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) parts.push(formatCost(cost));
  return parts.join(" · ");
}
