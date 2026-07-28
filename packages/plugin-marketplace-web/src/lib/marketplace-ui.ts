import { MarketplaceApiError } from "@/api.ts";

export const SESSION_KEY = "meta-agent-marketplace-session";
export const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});
export const numberFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export interface SessionState {
  token: string;
  expiresAt: number;
}

export function readSession(): SessionState | undefined {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<SessionState>;
    if (typeof value.token !== "string" || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) {
      clearSession();
      return undefined;
    }
    return { token: value.token, expiresAt: value.expiresAt };
  } catch {
    clearSession();
    return undefined;
  }
}

export function writeSession(session: SessionState): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    productivity: "效率",
    "developer-tools": "开发工具",
    communication: "沟通",
    automation: "自动化",
  };
  return labels[category] ?? category;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorMessage(reason: unknown): string {
  if (reason instanceof MarketplaceApiError) return reason.message;
  if (reason instanceof TypeError) return "无法连接插件市场服务，请确认 API 地址与网络状态。";
  return reason instanceof Error ? reason.message : "请求失败，请稍后重试。";
}

export function authErrorMessage(reason: unknown): string {
  if (reason instanceof MarketplaceApiError) {
    if (reason.code === "AUTH_INVALID") return "用户名或密码不正确。";
    if (reason.code === "AUTH_RATE_LIMITED") return "登录尝试过多，请稍后再试。";
    if (reason.code === "REGISTRATION_DISABLED") return "当前市场未开放账户注册。";
    if (reason.code === "USERNAME_TAKEN") return "该用户名已被使用。";
  }
  return errorMessage(reason);
}
