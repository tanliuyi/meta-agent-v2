import { Button } from "@renderer/shared/ui/button";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { AuthProviderDraft, AuthProviderInfo } from "../../../../shared/auth-config-contracts.ts";
import { AuthApiKeyForm } from "./auth-api-key-form.tsx";
import { AuthOauthDisplay } from "./auth-oauth-display.tsx";

interface AuthProviderDetailProps {
  provider: AuthProviderDraft;
  knownProviders: AuthProviderInfo[];
  onChange(next: AuthProviderDraft): void;
  onRemove(): void;
}

/** Right-side credential detail panel. */
export function AuthProviderDetail({ provider, knownProviders, onChange, onRemove }: AuthProviderDetailProps) {
  const knownProvider = knownProviders.find((kp) => kp.id === provider.key);
  const displayName = knownProvider?.displayName ?? provider.key;

  return (
    <div className="auth-provider-detail">
      <div className="auth-provider-heading">
        <div>
          <span className="auth-eyebrow">{knownProvider ? "内置 Provider" : "自定义 Provider"}</span>
          <h2>{displayName}</h2>
          <p>{provider.key}</p>
        </div>
        <Button variant="destructive" size="sm" onClick={onRemove}>
          <Trash2 />
          删除
        </Button>
      </div>

      <div className="auth-detail-content">
        {provider.apiKey && <AuthApiKeyForm provider={provider} knownProviders={knownProviders} onChange={onChange} />}

        {provider.oauth && <AuthOauthDisplay provider={provider} onRemove={onRemove} />}

        {!provider.apiKey && !provider.oauth && (
          <div className="auth-empty-detail">
            <p>该 provider 没有本地凭据配置。可添加 API key 或使用 OAuth 登录。</p>
            <Button
              onClick={() =>
                onChange({
                  ...provider,
                  apiKey: { key: "", env: [] },
                })
              }
            >
              添加 API Key
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
