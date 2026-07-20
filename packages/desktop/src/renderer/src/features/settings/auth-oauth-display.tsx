import { Button } from "@renderer/shared/ui/button";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import { useMemo } from "react";
import type { AuthProviderDraft } from "../../../../shared/auth-config-contracts.ts";

interface AuthOauthDisplayProps {
  provider: AuthProviderDraft;
  onRemove(): void;
}

function relativeTime(isoString: string): string {
  const expires = new Date(isoString).getTime();
  if (Number.isNaN(expires)) return "未知";
  const now = Date.now();
  const diff = expires - now;
  if (diff <= 0) return "已过期";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  return `${days} 天后`;
}

/** Read-only display of OAuth credential details. */
export function AuthOauthDisplay({ provider, onRemove }: AuthOauthDisplayProps) {
  const oauth = provider.oauth;
  const relative = useMemo(() => (oauth ? relativeTime(oauth.expires) : ""), [oauth?.expires]);

  if (!oauth) return null;

  return (
    <div className="auth-oauth-display">
      <div className="auth-field">
        <label className="auth-field-label">登录提供商</label>
        <span className="auth-oauth-value">{oauth.providerName}</span>
      </div>
      <div className="auth-field">
        <label className="auth-field-label">过期时间</label>
        <div className="auth-oauth-expiry">
          <span className="auth-oauth-value">
            {new Date(oauth.expires).toLocaleString()} ({relative})
          </span>
          {oauth.expired && <TriangleAlert className="auth-warning-icon" aria-label="已过期" />}
        </div>
      </div>
      <div className="auth-oauth-actions">
        <Button variant="destructive" onClick={onRemove}>
          移除凭据
        </Button>
      </div>
    </div>
  );
}
